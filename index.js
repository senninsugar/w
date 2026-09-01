import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// CORS設定
app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Requested-With']
}));

// 画像を直接プロキシしてデータURIまたはバイナリで渡す関数
async function fetchAsBase64(url) {
    if (!url) return null;
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://momon-ga.com/'
            }
        });

        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const arrayBuffer = await response.arrayBuffer();
        
        let binary = '';
        const bytes = new Uint8Array(arrayBuffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64String = btoa(binary);

        return `data:${contentType};base64,${base64String}`;
    } catch (e) {
        console.error(`Base64 Fetch Error: ${url}`, e.message);
        return null;
    }
}

// 検索 API
app.get('/api/search', async (c) => {
    const query = c.req.query('q') || '';

    try {
        const targetUrl = query 
            ? `https://momon-ga.com/?s=${encodeURIComponent(query)}`
            : `https://momon-ga.com/`;

        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = await response.text();
        const results = [];
        const postRegex = /<a href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img src="([^"]+)"[\s\S]*?alt="([^"]+)"/g;

        let match;
        while ((match = postRegex.exec(html)) !== null) {
            results.push({
                id: match[1],
                imageUrl: match[2],
                title: match[3],
                rule: ""
            });
        }

        return c.json({ result: results });

    } catch (error) {
        console.error("Search API Error:", error.message);
        return c.json({ error: "Search failed" }, 500);
    }
});

// 詳細取得 API
app.get('/api/proxy-details', async (c) => {
    const id = c.req.query('id');
    if (!id) return c.text("ID is required", 400);

    const targetUrl = `https://momon-ga.com/fanzine/${id}/`;

    try {
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const htmlString = await response.text();

        // 1. Title タグ
        const titleMatch = htmlString.match(/<title>([\s\S]*?)<\/title>/i);
        const rawTitle = titleMatch ? titleMatch[1].replace(/- momon-ga.*/, '').trim() : "";

        // 2. Meta Description
        const descMatch = htmlString.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
        const rawDescription = descMatch ? descMatch[1].trim() : "";

        // 3. ギャラリー画像 URL の抽出
        const imgUrls = [];
        const galleryRegex = /src="([^"]*galleries[^"]*)"/g;

        let match;
        while ((match = galleryRegex.exec(htmlString)) !== null) {
            let src = match[1];
            if (src.startsWith('/')) {
                src = 'https://momon-ga.com' + src;
            }
            imgUrls.push(src);
        }
        const uniqueImgUrls = [...new Set(imgUrls)];

        // 4. Description 解析
        const getMetaVal = (label) => {
            const reg = new RegExp(`【${label}】\\s*([^【]+)`);
            const m = rawDescription.match(reg);
            return m ? m[1].trim() : "";
        };

        const parody = getMetaVal("パロディ");
        const character = getMetaVal("キャラクター");
        const circle = getMetaVal("サークル");
        const author = getMetaVal("作者");
        const tagsStr = getMetaVal("タグ");
        const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : [];

        // 5. ページ数・投稿日時
        const pagesMatch = htmlString.match(/ページ数\s*:\s*(?:<[^>]+>\s*)*(\d+)\s*ページ/i);
        const pages = pagesMatch ? parseInt(pagesMatch[1], 10) : 0;

        const dateMatch = htmlString.match(/公開\/投稿日時\s*:\s*(?:<[^>]+>\s*)*<time[^>]*>([^<]+)<\/time>/i);
        const postDate = dateMatch ? dateMatch[1].trim() : "不明";

        // 6. コメントの抽出
        const comments = [];
        const commentRegex = /<div\s+class="comment\s+[^"]*id="comment-(\d+)"[^>]*>([\s\S]*?)(?=<div\s+class="comment\s+|<div\s+id="respond"|<\/div>\s*<\/li>|$)/gi;
        let commentBlockMatch;
        while ((commentBlockMatch = commentRegex.exec(htmlString)) !== null) {
            const block = commentBlockMatch[2];

            const numMatch = block.match(/<span\s+class="comment_num">([^<]+)<\/span>/);
            const authorMatch = block.match(/<span\s+class="comment_author">([^<]+)<\/span>/);
            const dateMatch = block.match(/<span\s+class="comment_date">([^<]+)<\/span>/);
            const textMatch = block.match(/<p>([\s\S]*?)<\/p>/);
            const likesMatch = block.match(/data-ulike-counter-value="([^"]+)"/);

            const num = numMatch ? numMatch[1].replace(/[^\d]/g, '').trim() : "";
            const authorName = authorMatch ? authorMatch[1].trim() : "";
            const date = dateMatch ? dateMatch[1].trim() : "";
            const text = textMatch ? textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>?/gm, '').trim() : "";
            const likes = likesMatch ? likesMatch[1].trim() : "";

            if (text || authorName) {
                comments.push({ num, author: authorName, date, text, likes });
            }
        }

        // 7. 関連作品
        const related = [];
        const relatedRegex = /<a\s+href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]+)"[\s\S]*?(?:<div\s+class="post-list-wpulike">([^<]+)<\/div>)?[\s\S]*?<\/a>/gi;
        let relatedMatch;
        while ((relatedMatch = relatedRegex.exec(htmlString)) !== null) {
            related.push({
                id: relatedMatch[1],
                imageUrl: relatedMatch[2],
                title: relatedMatch[3],
                likes: relatedMatch[4] ? relatedMatch[4].trim() : ""
            });
        }

        return c.json({
            title: rawTitle,
            description: rawDescription,
            parody,
            character,
            circle,
            author,
            pages,
            postDate,
            tags,
            images: uniqueImgUrls,
            comments,
            related
        });

    } catch (e) {
        console.error(e.message);
        return c.text("Detail fetch error", 500);
    }
});

// 画像ダイレクトプロキシ API (Base64 返却)
app.get('/api/image-proxy', async (c) => {
    const imageUrl = c.req.query('url');
    if (!imageUrl) return c.text("URL is required", 400);

    const base64Data = await fetchAsBase64(imageUrl);
    if (!base64Data) return c.text("Failed to fetch image", 502);

    return c.json({ image: base64Data });
});

// UI（HTML/CSS/JS）の配信
app.get('/', (c) => {
    return c.html(`
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Viewer</title>
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --text-color: #f8fafc;
            --accent-color: #38bdf8;
            --secondary-text: #94a3b8;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            line-height: 1.5;
        }
        header {
            position: sticky;
            top: 0;
            z-index: 100;
            background-color: rgba(15, 23, 42, 0.9);
            backdrop-filter: blur(8px);
            padding: 1rem;
            border-bottom: 1px solid #334155;
            display: flex;
            gap: 10px;
            justify-content: center;
        }
        input[type="text"] {
            width: 100%;
            max-width: 500px;
            padding: 0.6rem 1rem;
            border-radius: 8px;
            border: 1px solid #334155;
            background: #1e293b;
            color: #fff;
            font-size: 1rem;
            outline: none;
        }
        input[type="text"]:focus { border-color: var(--accent-color); }
        button {
            padding: 0.6rem 1.2rem;
            border-radius: 8px;
            border: none;
            background-color: var(--accent-color);
            color: #000;
            font-weight: bold;
            cursor: pointer;
            transition: opacity 0.2s;
        }
        button:hover { opacity: 0.9; }
        main { padding: 1.5rem; max-width: 1400px; margin: 0 auto; }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 1rem;
        }
        .card {
            background: var(--card-bg);
            border-radius: 8px;
            overflow: hidden;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
            display: flex;
            flex-direction: column;
        }
        .card:hover {
            transform: translateY(-4px);
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
        }
        .card img {
            width: 100%;
            aspect-ratio: 3/4;
            object-fit: cover;
            background: #334155;
        }
        .card-title {
            padding: 0.8rem;
            font-size: 0.85rem;
            font-weight: 500;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }
        /* Modal */
        .modal {
            display: none;
            position: fixed;
            inset: 0;
            z-index: 200;
            background: rgba(0,0,0,0.85);
            backdrop-filter: blur(5px);
            overflow-y: auto;
        }
        .modal-content {
            max-width: 1000px;
            margin: 2rem auto;
            background: var(--card-bg);
            border-radius: 12px;
            padding: 1.5rem;
            position: relative;
        }
        .close-btn {
            position: absolute;
            top: 1rem; right: 1rem;
            background: transparent;
            color: #fff;
            font-size: 1.5rem;
            cursor: pointer;
        }
        .meta-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 10px;
            margin: 1rem 0;
            background: #0f172a;
            padding: 1rem;
            border-radius: 8px;
            font-size: 0.9rem;
        }
        .tag-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .tag {
            background: #334155;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.8rem;
        }
        .gallery {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
            gap: 10px;
            margin-top: 1.5rem;
        }
        .gallery img {
            width: 100%;
            border-radius: 6px;
            cursor: pointer;
            aspect-ratio: 3/4;
            object-fit: cover;
        }
        .spinner {
            text-align: center;
            padding: 3rem;
            color: var(--secondary-text);
            font-size: 1.2rem;
        }
    </style>
</head>
<body>
    <header>
        <input type="text" id="searchInput" placeholder="検索キーワードを入力..." onkeypress="handleKeyPress(event)">
        <button onclick="performSearch()">検索</button>
    </header>

    <main>
        <div id="content" class="grid"></div>
    </main>

    <div id="detailModal" class="modal">
        <div class="modal-content">
            <button class="close-btn" onclick="closeModal()">✕</button>
            <h2 id="modalTitle"></h2>
            <div id="modalMeta" class="meta-grid"></div>
            <div id="modalGallery" class="gallery"></div>
        </div>
    </div>

    <script>
        const imageCache = new Map();

        async function proxyImage(url, targetImgElement) {
            if (imageCache.has(url)) {
                targetImgElement.src = imageCache.get(url);
                return;
            }
            try {
                const res = await fetch(\`/api/image-proxy?url=\${encodeURIComponent(url)}\`);
                const data = await res.json();
                if (data.image) {
                    imageCache.set(url, data.image);
                    targetImgElement.src = data.image;
                }
            } catch (e) {
                console.error("Image proxy failed", e);
            }
        }

        async function performSearch() {
            const query = document.getElementById('searchInput').value;
            const content = document.getElementById('content');
            content.className = '';
            content.innerHTML = '<div class="spinner">検索中...</div>';

            try {
                const res = await fetch(\`/api/search?q=\${encodeURIComponent(query)}\`);
                const data = await res.json();
                
                content.className = 'grid';
                content.innerHTML = '';

                if (!data.result || data.result.length === 0) {
                    content.innerHTML = '<div style="grid-column: 1/-1; text-align:center;">結果が見つかりませんでした</div>';
                    return;
                }

                data.result.forEach(item => {
                    const card = document.createElement('div');
                    card.className = 'card';
                    card.onclick = () => openDetails(item.id);

                    const img = document.createElement('img');
                    img.alt = item.title;
                    proxyImage(item.imageUrl, img);

                    const title = document.createElement('div');
                    title.className = 'card-title';
                    title.innerText = item.title;

                    card.appendChild(img);
                    card.appendChild(title);
                    content.appendChild(card);
                });
            } catch (e) {
                content.innerHTML = '<div style="grid-column: 1/-1; text-align:center; color:red;">エラーが発生しました</div>';
            }
        }

        async function openDetails(id) {
            const modal = document.getElementById('detailModal');
            const modalTitle = document.getElementById('modalTitle');
            const modalMeta = document.getElementById('modalMeta');
            const modalGallery = document.getElementById('modalGallery');

            modalTitle.innerText = "読み込み中...";
            modalMeta.innerHTML = '';
            modalGallery.innerHTML = '<div class="spinner">画像読み込み中...</div>';
            modal.style.display = 'block';

            try {
                const res = await fetch(\`/api/proxy-details?id=\${id}\`);
                const data = await res.json();

                modalTitle.innerText = data.title;
                modalMeta.innerHTML = \`
                    \${data.circle ? \`<div><b>サークル:</b> \${data.circle}</div>\` : ''}
                    \${data.author ? \`<div><b>作者:</b> \${data.author}</div>\` : ''}
                    \${data.parody ? \`<div><b>原作:</b> \${data.parody}</div>\` : ''}
                    \${data.character ? \`<div><b>キャラ:</b> \${data.character}</div>\` : ''}
                    \${data.pages ? \`<div><b>ページ数:</b> \${data.pages}P</div>\` : ''}
                    \${data.postDate ? \`<div><b>投稿日:</b> \${data.postDate}</div>\` : ''}
                    <div style="grid-column: 1/-1;">
                        <b>タグ:</b>
                        <div class="tag-list">
                            \${data.tags.map(t => \`<span class="tag">\${t}</span>\`).join('')}
                        </div>
                    </div>
                \`;

                modalGallery.innerHTML = '';
                data.images.forEach(url => {
                    const img = document.createElement('img');
                    proxyImage(url, img);
                    img.onclick = () => window.open(img.src, '_blank');
                    modalGallery.appendChild(img);
                });

            } catch (e) {
                modalTitle.innerText = "エラー";
                modalGallery.innerHTML = "詳細情報の取得に失敗しました。";
            }
        }

        function closeModal() {
            document.getElementById('detailModal').style.display = 'none';
        }

        function handleKeyPress(e) {
            if (e.key === 'Enter') performSearch();
        }

        // 初回起動時にトップページ一覧を表示
        performSearch();
    </script>
</body>
</html>
    `);
});

export default app;
