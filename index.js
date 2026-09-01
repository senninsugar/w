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
            --accent-hover: #0284c7;
            --secondary-text: #94a3b8;
            --border-color: #334155;
            --skeleton-base: #1e293b;
            --skeleton-highlight: #334155;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            line-height: 1.5;
            min-height: 100vh;
        }

        header {
            position: sticky;
            top: 0;
            z-index: 100;
            background-color: rgba(15, 23, 42, 0.8);
            backdrop-filter: blur(12px);
            padding: 1rem 1.5rem;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            gap: 12px;
            justify-content: center;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        }

        .search-box {
            display: flex;
            width: 100%;
            max-width: 600px;
            gap: 8px;
        }

        input[type="text"] {
            flex: 1;
            padding: 0.75rem 1.25rem;
            border-radius: 10px;
            border: 1px solid var(--border-color);
            background: rgba(30, 41, 59, 0.7);
            color: #fff;
            font-size: 0.95rem;
            outline: none;
            transition: border-color 0.2s, box-shadow 0.2s;
        }

        input[type="text"]:focus { 
            border-color: var(--accent-color);
            box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2);
        }

        button {
            padding: 0.75rem 1.5rem;
            border-radius: 10px;
            border: none;
            background-color: var(--accent-color);
            color: #0f172a;
            font-weight: 700;
            cursor: pointer;
            transition: background-color 0.2s, transform 0.1s;
        }

        button:hover { background-color: var(--accent-hover); }
        button:active { transform: scale(0.98); }

        main { padding: 2rem 1.5rem; max-width: 1400px; margin: 0 auto; }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 1.25rem;
        }

        /* Card Styles */
        .card {
            background: var(--card-bg);
            border-radius: 12px;
            overflow: hidden;
            cursor: pointer;
            border: 1px solid var(--border-color);
            transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 0.25s, border-color 0.25s;
            display: flex;
            flex-direction: column;
            animation: fadeIn 0.4s ease-out forwards;
        }

        .card:hover {
            transform: translateY(-6px);
            box-shadow: 0 12px 24px -6px rgba(0, 0, 0, 0.6);
            border-color: var(--accent-color);
        }

        .card-img-wrapper {
            position: relative;
            width: 100%;
            aspect-ratio: 3/4;
            background: var(--border-color);
            overflow: hidden;
        }

        .card img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            transition: opacity 0.3s;
        }

        .card-title {
            padding: 1rem;
            font-size: 0.875rem;
            font-weight: 500;
            line-height: 1.4;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            color: var(--text-color);
        }

        /* Modal */
        .modal {
            display: none;
            position: fixed;
            inset: 0;
            z-index: 200;
            background: rgba(15, 23, 42, 0.85);
            backdrop-filter: blur(8px);
            overflow-y: auto;
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .modal.active {
            display: block;
            opacity: 1;
        }

        .modal-content {
            max-width: 900px;
            margin: 3rem auto;
            background: var(--card-bg);
            border-radius: 16px;
            border: 1px solid var(--border-color);
            padding: 2rem;
            position: relative;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
            transform: translateY(20px);
            transition: transform 0.3s ease;
        }

        .modal.active .modal-content {
            transform: translateY(0);
        }

        .close-btn {
            position: absolute;
            top: 1.25rem; 
            right: 1.25rem;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 50%;
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fff;
            font-size: 1.2rem;
            cursor: pointer;
            transition: background 0.2s, transform 0.2s;
        }

        .close-btn:hover {
            background: rgba(255, 255, 255, 0.2);
            transform: rotate(90deg);
        }

        .meta-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 12px;
            margin: 1.5rem 0;
            background: rgba(15, 23, 42, 0.6);
            padding: 1.25rem;
            border-radius: 10px;
            border: 1px solid var(--border-color);
            font-size: 0.9rem;
        }

        .tag-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .tag {
            background: var(--border-color);
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 0.8rem;
            color: var(--accent-color);
        }

        .gallery {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
            gap: 12px;
            margin-top: 1.5rem;
        }

        .gallery img {
            width: 100%;
            border-radius: 8px;
            cursor: pointer;
            aspect-ratio: 3/4;
            object-fit: cover;
            border: 1px solid transparent;
            transition: transform 0.2s, border-color 0.2s;
        }

        .gallery img:hover {
            transform: scale(1.03);
            border-color: var(--accent-color);
        }

        /* Animations & Skeletons */
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        @keyframes pulse {
            0% { background-position: 0% 0%; }
            100% { background-position: -200% 0%; }
        }

        .skeleton {
            background: linear-gradient(90deg, var(--skeleton-base) 25%, var(--skeleton-highlight) 37%, var(--skeleton-base) 63%);
            background-size: 200% 100%;
            animation: pulse 1.5s infinite ease-in-out;
        }

        .spinner-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 4rem;
            gap: 1rem;
            grid-column: 1 / -1;
            color: var(--secondary-text);
        }

        .spinner-ring {
            width: 40px;
            height: 40px;
            border: 4px solid var(--border-color);
            border-top-color: var(--accent-color);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <header>
        <div class="search-box">
            <input type="text" id="searchInput" placeholder="検索キーワードを入力..." onkeypress="handleKeyPress(event)">
            <button onclick="performSearch()">検索</button>
        </div>
    </header>

    <main>
        <div id="content" class="grid"></div>
    </main>

    <div id="detailModal" class="modal" onclick="handleModalClick(event)">
        <div class="modal-content">
            <button class="close-btn" onclick="closeModal()">✕</button>
            <h2 id="modalTitle"></h2>
            <div id="modalMeta"></div>
            <div id="modalGallery" class="gallery"></div>
        </div>
    </div>

    <script>
        const imageCache = new Map();

        async function proxyImage(url, targetImgElement) {
            if (imageCache.has(url)) {
                targetImgElement.src = imageCache.get(url);
                targetImgElement.style.opacity = '1';
                return;
            }
            try {
                const res = await fetch(`/api/image-proxy?url=${encodeURIComponent(url)}`);
                const data = await res.json();
                if (data.image) {
                    imageCache.set(url, data.image);
                    targetImgElement.src = data.image;
                    targetImgElement.style.opacity = '1';
                }
            } catch (e) {
                console.error("Image proxy failed", e);
            }
        }

        function renderSkeletons(count = 10) {
            const content = document.getElementById('content');
            content.className = 'grid';
            content.innerHTML = Array(count).fill(0).map(() => `
                <div class="card" style="pointer-events: none;">
                    <div class="card-img-wrapper skeleton"></div>
                    <div class="card-title">
                        <div class="skeleton" style="height: 1em; width: 90%; margin-bottom: 6px; border-radius: 4px;"></div>
                        <div class="skeleton" style="height: 1em; width: 60%; border-radius: 4px;"></div>
                    </div>
                </div>
            `).join('');
        }

        async function performSearch() {
            const query = document.getElementById('searchInput').value;
            const content = document.getElementById('content');
            
            renderSkeletons();

            try {
                const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
                const data = await res.json();
                
                content.innerHTML = '';

                if (!data.result || data.result.length === 0) {
                    content.innerHTML = '<div class="spinner-container">結果が見つかりませんでした</div>';
                    return;
                }

                data.result.forEach((item, index) => {
                    const card = document.createElement('div');
                    card.className = 'card';
                    card.style.animationDelay = `${index * 0.03}s`;
                    card.onclick = () => openDetails(item.id);

                    const imgWrapper = document.createElement('div');
                    imgWrapper.className = 'card-img-wrapper skeleton';

                    const img = document.createElement('img');
                    img.alt = item.title;
                    img.style.opacity = '0';
                    img.onload = () => imgWrapper.classList.remove('skeleton');
                    
                    proxyImage(item.imageUrl, img);

                    const title = document.createElement('div');
                    title.className = 'card-title';
                    title.innerText = item.title;

                    imgWrapper.appendChild(img);
                    card.appendChild(imgWrapper);
                    card.appendChild(title);
                    content.appendChild(card);
                });
            } catch (e) {
                content.innerHTML = '<div class="spinner-container" style="color:#f87171;">エラーが発生しました。時間を置いて再度お試しください。</div>';
            }
        }

        async function openDetails(id) {
            const modal = document.getElementById('detailModal');
            const modalTitle = document.getElementById('modalTitle');
            const modalMeta = document.getElementById('modalMeta');
            const modalGallery = document.getElementById('modalGallery');

            modalTitle.innerText = "読み込み中...";
            modalMeta.innerHTML = '';
            modalGallery.innerHTML = `
                <div class="spinner-container">
                    <div class="spinner-ring"></div>
                    <span>詳細を読み込み中...</span>
                </div>
            `;
            
            modal.style.display = 'block';
            // Trigger reflow for CSS transition
            modal.offsetHeight; 
            modal.classList.add('active');

            try {
                const res = await fetch(`/api/proxy-details?id=${id}`);
                const data = await res.json();

                modalTitle.innerText = data.title;
                modalMeta.className = 'meta-grid';
                modalMeta.innerHTML = `
                    ${data.circle ? `<div><b>サークル:</b> ${data.circle}</div>` : ''}
                    ${data.author ? `<div><b>作者:</b> ${data.author}</div>` : ''}
                    ${data.parody ? `<div><b>原作:</b> ${data.parody}</div>` : ''}
                    ${data.character ? `<div><b>キャラ:</b> ${data.character}</div>` : ''}
                    ${data.pages ? `<div><b>ページ数:</b> ${data.pages}P</div>` : ''}
                    ${data.postDate ? `<div><b>投稿日:</b> ${data.postDate}</div>` : ''}
                    ${data.tags && data.tags.length ? `
                        <div style="grid-column: 1/-1;">
                            <b>タグ:</b>
                            <div class="tag-list">
                                ${data.tags.map(t => `<span class="tag">${t}</span>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                `;

                modalGallery.innerHTML = '';
                data.images.forEach(url => {
                    const img = document.createElement('img');
                    img.className = 'skeleton';
                    img.onload = () => img.classList.remove('skeleton');
                    proxyImage(url, img);
                    img.onclick = () => window.open(img.src, '_blank');
                    modalGallery.appendChild(img);
                });

            } catch (e) {
                modalTitle.innerText = "エラー";
                modalGallery.innerHTML = "<div style='grid-column: 1/-1; text-align: center; color: #f87171;'>詳細情報の取得に失敗しました。</div>";
            }
        }

        function closeModal() {
            const modal = document.getElementById('detailModal');
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 300);
        }

        function handleModalClick(e) {
            if (e.target.id === 'detailModal') closeModal();
        }

        function handleKeyPress(e) {
            if (e.key === 'Enter') performSearch();
        }

        performSearch();
    </script>
</body>
</html>
    `);
});

export default app;
