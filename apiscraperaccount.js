// instagram_api_scraper.js (v2 - FIXED Listener Logic + Added Debug Mode)
// Dibuat oleh Gemini, berdasarkan permintaan pengguna
// Metode: Intersepsi Network Request API (GraphQL & v1)
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const fs = require('fs');
const readline = require('readline'); // <-- TAMBAHKAN INI

// ======== KONFIGURASI ========
const CONFIG = {
    // Ganti dengan kredensial Anda
    ig_username: "catharinawijaya36@gmail.com",
    ig_password: "UrLoVeRUrB@Ebook",
    
    // Target akun yang ingin di-scrape
    target_usernames: ["obontabroni", "fadlizon", "dedimulyadi71"],
    
    // Jeda antar akun (dalam detik)
    account_delay_seconds: 30,
    
    // Folder output
    output_folder: "./instagram_data_api",
    
    // Lokasi data sesi (untuk menyimpan login)
    userDataDir: path.join(os.homedir(), 'playwright_ig_api_session'),
    
    // Batas scroll untuk postingan (misal 10x scroll)
    MAX_PROFILE_SCROLLS: 10,  // ← NAIKKAN untuk first run!
    
    // Batas scroll untuk komentar per postingan (misal 5x scroll)
    MAX_COMMENT_SCROLLS: 3, 
    MAX_COMMENTS_PER_POST: 200,
    LOCATION_WAIT_SECONDS: 12,
    
    // ========== HISTORICAL CUTOFF (5 TAHUN) ==========
    MAX_POST_AGE_DAYS: 1825,         // ← 5 tahun = 365 × 5 = 1825 hari
    
    // ========== BATCH LIMITER (FIRST RUN) ==========
    MAX_POSTS_PER_ACCOUNT: null,     // ← null = unlimited (dalam 5 tahun)
    
    // ========== MODE DETECTION ==========
    // Auto-detect: jika file kosong = FIRST RUN, jika ada data = MAINTENANCE
    AUTO_DETECT_MODE: true,
    
    // Force mode (untuk testing)
    FORCE_MODE: null,  // ← null = auto, 'first_run', atau 'maintenance'
    
    // ========== MAINTENANCE MODE (RUN 2+) ==========
    MAINTENANCE_MODE: {
        MAX_NEW_POSTS_TO_CHECK: 50,   // ← Cek 50 post terbaru saja
        ONLY_UPDATE_RECENT: true,     // ← Hanya update post ≤7 hari
    },
    
    // ========== FITUR UNGGUL: 7-DAY GRADUAL DECAY + SPIKE DETECTION ==========
    ENABLE_ENGAGEMENT_UPDATE: true,
    
    // Timezone (untuk akurasi waktu)
    TIMEZONE: 'Asia/Jakarta',
    TIMEZONE_OFFSET: 7,
    
    // 7-Day Gradual Decay Strategy
    UPDATE_SCHEDULE: {
        // PHASE 1: Golden Window (0-24 jam)
        GOLDEN_WINDOW_HOURS: 24,
        GOLDEN_UPDATE_EVERY: 2,
        
        // PHASE 2: Momentum Phase (1-3 hari)
        MOMENTUM_WINDOW_DAYS: 3,
        MOMENTUM_UPDATE_EVERY: 6,
        
        // PHASE 3: Stabilization Phase (3-7 hari)
        STABILIZATION_WINDOW_DAYS: 7,
        STABILIZATION_UPDATE_EVERY: 24,
        
        // PHASE 4: Archive (>7 hari)
        MAX_UPDATE_AGE_DAYS: 7,
        
        // Smart Spike Detection
        ENABLE_SPIKE_DETECTION: true,
        SPIKE_THRESHOLD: 50,
        SPIKE_UPDATE_EVERY: 1,
    },
    
    // Prime Time Update
    PRIME_TIME_UPDATE: {
        ENABLED: true,
        START_HOUR: 9,
        END_HOUR: 23,
    },
    
    // ========= PENGATURAN DEBUG PAUSE =========
    DEBUG_MODE: false,
    PAUSE_AFTER_PROFILE_SCROLL: false,
    PAUSE_AFTER_EACH_POST: false,
};

// ======== PENYIMPANAN DATA (GLOBAL) ========
const allPosts = new Map();     // Key: post_pk
const allComments = new Map();  // Key: comment_pk
const commentPaginationState = new Map(); // ← TAMBAHKAN BARIS INI

// ========== DETECT SCRAPING MODE (First Run vs Maintenance) ==========
function detectScrapingMode(username) {
    // Jika force mode aktif
    if (CONFIG.FORCE_MODE) {
        console.log(`[MODE] Force mode: ${CONFIG.FORCE_MODE.toUpperCase()}`);
        return CONFIG.FORCE_MODE;
    }
    
    // Auto-detect berdasarkan file
    const jsonFile = getPostsJSONFilename();
    
    if (!fs.existsSync(jsonFile)) {
        console.log(`[MODE] 🆕 FIRST RUN detected (no existing data file)`);
        return 'first_run';
    }
    
    try {
        const content = fs.readFileSync(jsonFile, 'utf8');
        const posts = JSON.parse(content);
        
        // Cek apakah ada post untuk username ini
        const userPosts = posts.filter(p => p.query_used === username);
        
        if (userPosts.length === 0) {
            console.log(`[MODE] 🆕 FIRST RUN for @${username} (no existing posts)`);
            return 'first_run';
        }
        
        // Cek apakah ada post lebih dari 30 hari (indikasi first run sudah selesai)
        const oldestPost = userPosts.reduce((oldest, post) => {
            return post.timestamp < oldest.timestamp ? post : oldest;
        });
        
        const daysSinceOldest = (Date.now() / 1000 - oldestPost.timestamp) / 86400;
        
        if (daysSinceOldest < 30) {
            console.log(`[MODE] 🔄 MAINTENANCE MODE for @${username} (oldest post: ${Math.round(daysSinceOldest)} days)`);
            return 'maintenance';
        } else {
            console.log(`[MODE] 🔄 MAINTENANCE MODE for @${username} (${userPosts.length} existing posts)`);
            return 'maintenance';
        }
        
    } catch (e) {
        console.log(`[MODE] 🆕 FIRST RUN (error reading file, treating as new)`);
        return 'first_run';
    }
}

// ========== HELPER: Convert ISO to WIB ==========
function convertToWIB(isoString) {
    if (!isoString) return "N/A";
    try {
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return "N/A";
        
        // WIB = UTC+7
        const wibDate = new Date(date.getTime() + (7 * 60 * 60 * 1000));
        
        const year = wibDate.getUTCFullYear();
        const month = String(wibDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(wibDate.getUTCDate()).padStart(2, '0');
        const hours = String(wibDate.getUTCHours()).padStart(2, '0');
        const minutes = String(wibDate.getUTCMinutes()).padStart(2, '0');
        const seconds = String(wibDate.getUTCSeconds()).padStart(2, '0');
        
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} WIB`;
    } catch (e) {
        return "N/A";
    }
}

// ========== HELPER: Parse Unix Timestamp to ISO ==========
function unixToISO(unixTimestamp) {
    if (!unixTimestamp) return null;
    try {
        const date = new Date(unixTimestamp * 1000);
        return date.toISOString();
    } catch (e) {
        return null;
    }
}

// ========== HELPER: Clean Text for CSV ==========
// ========== AGGRESSIVE TEXT CLEANING (Remove ALL Special Chars!) ==========
function cleanTextForCSV(text) {
    if (!text) return "";
    
    let cleaned = String(text);
    
    // 1. Remove ALL newlines (berbagai jenis)
    cleaned = cleaned.replace(/\r\n/g, ' ');    // Windows newline
    cleaned = cleaned.replace(/\n\r/g, ' ');    // Rare variant
    cleaned = cleaned.replace(/\r/g, ' ');      // Old Mac newline
    cleaned = cleaned.replace(/\n/g, ' ');      // Unix/Linux newline
    
    // 2. Remove tabs
    cleaned = cleaned.replace(/\t/g, ' ');
    
    // 3. Remove vertical tabs & form feeds
    cleaned = cleaned.replace(/\v/g, ' ');
    cleaned = cleaned.replace(/\f/g, ' ');
    
    // 4. Remove zero-width characters (invisible chars)
    cleaned = cleaned.replace(/\u200B/g, '');   // Zero-width space
    cleaned = cleaned.replace(/\u200C/g, '');   // Zero-width non-joiner
    cleaned = cleaned.replace(/\u200D/g, '');   // Zero-width joiner
    cleaned = cleaned.replace(/\uFEFF/g, '');   // Zero-width no-break space (BOM)
    
    // 5. Remove control characters (ASCII 0-31 except space)
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, ' ');
    
    // 6. Normalize quotes (gunakan straight quotes untuk CSV)
    cleaned = cleaned.replace(/[""]/g, '"');    // Curly double quotes → straight
    cleaned = cleaned.replace(/['']/g, "'");    // Curly single quotes → straight
    cleaned = cleaned.replace(/[«»]/g, '"');    // Guillemets → straight quotes
    
    // 7. Replace multiple spaces with single space
    cleaned = cleaned.replace(/\s{2,}/g, ' ');
    
    // 8. Trim whitespace from start and end
    cleaned = cleaned.trim();
    
    // 9. Escape internal quotes for CSV safety
    cleaned = cleaned.replace(/"/g, '""');  // " → "" (CSV standard escaping)
    
    return cleaned;
}

// ========== GLOBAL FILE NAMES (Semua akun jadi 1 file!) ==========
function getPostsCSVFilename() {
    return path.join(CONFIG.output_folder, 'instagram_posts.csv');  // ← GLOBAL!
}

function getCommentsCSVFilename() {
    return path.join(CONFIG.output_folder, 'instagram_comments.csv');  // ← GLOBAL!
}

function getPostsJSONFilename() {
    return path.join(CONFIG.output_folder, 'instagram_posts.json');  // ← GLOBAL!
}

function getCommentsJSONFilename() {
    return path.join(CONFIG.output_folder, 'instagram_comments.json');  // ← GLOBAL!
}

// ========== CHECK DUPLIKASI: POST ==========
async function isPostDuplicate(postUrl) {  // ← HAPUS username parameter
    const cleanUrl = postUrl.split('?')[0];
    
    // Check in memory
    if (allPosts.has(cleanUrl)) {
        return { isDuplicate: true, reason: 'In memory' };
    }
    
    // Check in CSV
    const csvFile = getPostsCSVFilename();  // ← Tidak ada username!
    if (fs.existsSync(csvFile)) {
        try {
            const csvContent = fs.readFileSync(csvFile, 'utf8');
            if (csvContent.includes(cleanUrl)) {
                return { isDuplicate: true, reason: 'Found in CSV' };
            }
        } catch (e) {}
    }
    
    // Check in JSON
    const jsonFile = getPostsJSONFilename();
    if (fs.existsSync(jsonFile)) {
        try {
            const jsonContent = fs.readFileSync(jsonFile, 'utf8');
            const postsData = JSON.parse(jsonContent);
            if (postsData.some(p => p.post_url === cleanUrl)) {
                return { isDuplicate: true, reason: 'Found in JSON' };
            }
        } catch (e) {}
    }
    
    return { isDuplicate: false, reason: 'New post' };
}

// ========== SAVE SINGLE POST (REAL-TIME!) ==========
async function savePostRealtime(postData) {
    try {
        console.log(`      💾 Saving post to CSV & JSON...`);
        
        // ========== SAVE TO CSV ==========
        const csvFile = getPostsCSVFilename();
        const fileExists = fs.existsSync(csvFile);
        
        if (!fileExists) {
            fs.writeFileSync(csvFile, '\ufeff'); // BOM for UTF-8
        }
        
        const { createObjectCsvWriter } = require('csv-writer');
        const postWriter = createObjectCsvWriter({
            path: csvFile,
            header: [
                {id: 'author', title: 'author'},
                {id: 'author_profile_link', title: 'author_profile_link'},
                {id: 'location', title: 'location'},
                {id: 'audio_source', title: 'audio_source'},
                {id: 'timestamp', title: 'timestamp'},
                {id: 'timestamp_iso', title: 'timestamp_iso'},
                {id: 'timestamp_wib', title: 'timestamp_wib'},
                {id: 'post_url', title: 'post_url'},
                {id: 'content_text', title: 'content_text'},
                {id: 'image_url', title: 'image_url'},
                {id: 'video_url', title: 'video_url'},
                {id: 'image_source', title: 'image_source'},
                {id: 'video_source', title: 'video_source'},
                {id: 'likes', title: 'likes'},
                {id: 'comments', title: 'comments'},
                {id: 'views', title: 'views'},  // ← TAMBAH: views
                {id: 'query_used', title: 'query_used'},
                {id: 'scraped_at', title: 'scraped_at'},
                {id: 'scraped_at_wib', title: 'scraped_at_wib'},  // ← TAMBAH WIB!
                {id: 'updated_at', title: 'updated_at'},
                {id: 'updated_at_wib', title: 'updated_at_wib'},  // ← TAMBAH WIB!
                {id: 'update_count', title: 'update_count'}  // ← TAMBAH: berapa kali di-update
            ],
            append: fileExists,
            alwaysQuote: true,           // ← PENTING: Quote semua field
            fieldDelimiter: ',',         // ← TAMBAH INI: Explicit delimiter
            recordDelimiter: '\r\n',     // ← TAMBAH INI: Windows-style newline untuk CSV
            encoding: 'utf8'
        });
        
        await postWriter.writeRecords([postData]);
        console.log(`         ✅ CSV saved: ${csvFile}`);
        
        // ========== SAVE TO JSON ==========
        const jsonFile = getPostsJSONFilename();
        let existingData = [];
        
        if (fs.existsSync(jsonFile)) {
            try {
                const content = fs.readFileSync(jsonFile, 'utf8');
                existingData = JSON.parse(content);
            } catch (e) {
                console.warn(`         ⚠️ Failed to parse JSON, creating new`);
            }
        }
        
        // Add new post (avoid duplicate)
        const exists = existingData.some(p => p.post_url === postData.post_url);
        if (!exists) {
            existingData.push(postData);
        }
        
        fs.writeFileSync(jsonFile, JSON.stringify(existingData, null, 2), 'utf8');
        console.log(`         ✅ JSON saved: ${jsonFile} (${existingData.length} posts)`);
        
        return true;
        
    } catch (error) {
        console.error(`         ❌ Save error: ${error.message}`);
        return false;
    }
}

// ========== SAVE COMMENTS (REAL-TIME!) ==========
async function saveCommentsRealtime(commentsData) {
    if (commentsData.length === 0) return true;
    
    try {
        console.log(`      💾 Saving ${commentsData.length} comments...`);
        
        // ========== SAVE TO CSV ==========
        const csvFile = getCommentsCSVFilename();
        const fileExists = fs.existsSync(csvFile);
        
        if (!fileExists) {
            fs.writeFileSync(csvFile, '\ufeff'); // BOM
        }
        
        const { createObjectCsvWriter } = require('csv-writer');
        const commentWriter = createObjectCsvWriter({
            path: csvFile,
            header: [
                {id: 'post_url', title: 'post_url'},
                {id: 'post_author', title: 'post_author'},
                {id: 'comment_author', title: 'comment_author'},
                {id: 'comment_author_link', title: 'comment_author_link'},
                {id: 'comment_text', title: 'comment_text'},
                {id: 'comment_likes', title: 'comment_likes'},
                {id: 'comment_timestamp', title: 'comment_timestamp'},
                {id: 'comment_timestamp_wib', title: 'comment_timestamp_wib'},
                {id: 'is_reply', title: 'is_reply'},
                {id: 'parent_comment_author', title: 'parent_comment_author'},
                {id: 'scraped_at', title: 'scraped_at'}
            ],
            append: fileExists,
            alwaysQuote: true,           // ← PENTING
            fieldDelimiter: ',',         // ← TAMBAH
            recordDelimiter: '\r\n',     // ← TAMBAH
            encoding: 'utf8'
        });
        
        await commentWriter.writeRecords(commentsData);
        console.log(`         ✅ CSV saved: ${csvFile}`);
        
        // ========== SAVE TO JSON ==========
        const jsonFile = getCommentsJSONFilename();
        let existingData = [];
        
        if (fs.existsSync(jsonFile)) {
            try {
                const content = fs.readFileSync(jsonFile, 'utf8');
                existingData = JSON.parse(content);
            } catch (e) {}
        }
        
        // Merge comments (avoid duplicates)
        const existingKeys = new Set(
            existingData.map(c => `${c.post_url}:${c.comment_author}:${c.comment_text.substring(0, 50)}`)
        );
        
        for (const comment of commentsData) {
            const key = `${comment.post_url}:${comment.comment_author}:${comment.comment_text.substring(0, 50)}`;
            if (!existingKeys.has(key)) {
                existingData.push(comment);
                existingKeys.add(key);
            }
        }
        
        fs.writeFileSync(jsonFile, JSON.stringify(existingData, null, 2), 'utf8');
        console.log(`         ✅ JSON saved: ${jsonFile} (${existingData.length} comments)`);
        
        return true;
        
    } catch (error) {
        console.error(`         ❌ Save error: ${error.message}`);
        return false;
    }
}

// ========== BATCH LIMITER: 200 POST PER JAM ==========
const batchLimiter = {
    startTime: null,
    postsProcessed: 0,
    MAX_POSTS_PER_HOUR: 200,
    
    reset() {
        this.startTime = Date.now();
        this.postsProcessed = 0;
    },
    
    async checkAndWait() {
        if (this.startTime === null) {
            this.reset();
            return;
        }
        
        this.postsProcessed++;
        
        // Check if reached limit
        if (this.postsProcessed >= this.MAX_POSTS_PER_HOUR) {
            const elapsed = Date.now() - this.startTime;
            const oneHour = 60 * 60 * 1000;
            
            if (elapsed < oneHour) {
                const waitTime = oneHour - elapsed;
                const waitMinutes = Math.ceil(waitTime / 1000 / 60);
                
                console.log(`\n   ⏸️  BATCH LIMIT REACHED: ${this.postsProcessed} posts in ${Math.round(elapsed / 1000 / 60)} minutes`);
                console.log(`   ⏳ Waiting ${waitMinutes} minutes before next batch...\n`);
                
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
            
            // Reset for next batch
            this.reset();
            console.log(`\n   ✅ Starting new batch...\n`);
        }
    },
    
    getStatus() {
        if (this.startTime === null) return "Not started";
        
        const elapsed = Date.now() - this.startTime;
        const minutes = Math.round(elapsed / 1000 / 60);
        const remaining = this.MAX_POSTS_PER_HOUR - this.postsProcessed;
        
        return `${this.postsProcessed}/${this.MAX_POSTS_PER_HOUR} posts (${minutes} min elapsed, ${remaining} remaining)`;
    }
};

// ======== FUNGSI DEBUG PAUSE (v2.2 - Kontrol Spesifik) ========
async function debugPause(page, message, pauseType) {
    // 1. Cek Master Switch
    if (!CONFIG.DEBUG_MODE) {
        return; // Langsung lanjut jika DEBUG_MODE = false
    }

    // 2. Cek Switch Spesifik
    let shouldPause = false;
    if (pauseType === 'profile' && CONFIG.PAUSE_AFTER_PROFILE_SCROLL) {
        shouldPause = true;
    } else if (pauseType === 'post' && CONFIG.PAUSE_AFTER_EACH_POST) {
        shouldPause = true;
    } else if (!pauseType) { 
        // Jika tidak ada tipe, ini adalah pause penting (spt login)
        shouldPause = true; 
    }

    // 3. Hanya pause jika lolos pengecekan
    if (shouldPause) {
        console.log(`\n${"🔍".repeat(35)}`);
        console.log(`🔍 DEBUG PAUSE: ${message}`);
        console.log(`🔍 URL Saat Ini: ${page.url()}`);
        console.log(`🔍 Tekan ENTER untuk melanjutkan...`);
        console.log(`${"🔍".repeat(35)}\n`);
        
        return new Promise(resolve => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            rl.question('', () => {
                rl.close();
                console.log(`✅ Melanjutkan...\n`);
                resolve();
            });
        });
    } else {
        // Jika switch spesifik-nya false, cetak log tapi jangan pause
        console.log(`[DEBUG] Melanjutkan otomatis: ${message}`);
    }
}

// ========== FUNGSI BARU: MEMUAT DATA YANG SUDAH ADA ==========

async function loadExistingData(username) {
    console.log(`[LOAD] Mengecek data lama untuk @${username}...`);
    
    // ← UBAH: Gunakan global file (bukan per-username)
    const postFile = getPostsJSONFilename();
    const commentFile = getCommentsJSONFilename();
    
    let loadedPosts = 0;
    let loadedComments = 0;
    
    try {
        // Muat Postingan Lama (filter by username)
        if (fs.existsSync(postFile)) {
            const data = JSON.parse(fs.readFileSync(postFile, 'utf8'));
            for (const post of data) {
                // ← TAMBAH FILTER: Hanya load post untuk username ini
                if (post.query_used === username && !allPosts.has(post.post_pk)) {
                    allPosts.set(post.post_pk, post);
                    loadedPosts++;
                }
            }
        }
        
        // Muat Komentar Lama (filter by username)
        if (fs.existsSync(commentFile)) {
            const data = JSON.parse(fs.readFileSync(commentFile, 'utf8'));
            for (const comment of data) {
                // ← TAMBAH FILTER: Hanya load comment untuk username ini
                if (comment.post_url && comment.post_url.includes(username) && !allComments.has(comment.comment_pk)) {
                    allComments.set(comment.comment_pk, comment);
                    loadedComments++;
                }
            }
        }
        
        if (loadedPosts > 0 || loadedComments > 0) {
            console.log(`   ✅ RESUME: Berhasil memuat ${loadedPosts} postingan dan ${loadedComments} komentar dari file.`);
            console.log(`   > Postingan baru akan ditambahkan. Postingan lama akan di-skip.`);
        } else {
            console.log(`   > Tidak ada data lama untuk @${username}.`);
        }
    } catch (e) {
        console.warn(`[LOAD] Gagal memuat file JSON lama: ${e.message}. Memulai dari awal.`);
    }
}

// ========== FUNGSI UTAMA: Menjalankan Scraper ==========
async function main() {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🚀 Memulai Instagram API Scraper...`);
    console.log(`   Sesi disimpan di: ${CONFIG.userDataDir}`);
    console.log(`${"=".repeat(60)}`);

    if (!fs.existsSync(CONFIG.output_folder)) {
        fs.mkdirSync(CONFIG.output_folder, { recursive: true });
    }

    let browser;
    try {
        const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
            headless: false,
            channel: 'chrome',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: null,  // ← UBAH: null = ikuti ukuran window
            args: [
                '--disable-blink-features=AutomationControlled',
                '--start-maximized',  // ← MAXIMIZE (window penuh tapi ada taskbar)
                '--window-position=0,0',  // ← Posisi di pojok kiri atas
            ]
        });

        const page = await context.newPage();

        // ← TAMBAHAN: Force maximize dengan JavaScript
        await page.evaluate(() => {
            window.moveTo(0, 0);
            window.resizeTo(screen.availWidth, screen.availHeight);
        });
        await page.setViewportSize({ width: 1600, height: 900 });

        // Cek login
        if (!(await checkLogin(page))) {
            console.log("🔐 Sesi tidak valid, mencoba login baru...");
            if (!(await loginToInstagram(page, CONFIG.ig_username, CONFIG.ig_password))) {
                console.error("❌ Login gagal. Tutup browser dan coba hapus folder sesi.");
                await context.close();
                return;
            }
        }

        // Kode BARU
        await debugPause(page, "Login berhasil. Siap memasang listener API.", 'profile');

        // Pasang "telinga" (listener) untuk semua respons jaringan
        setupApiListeners(page);
        
        for (let i = 0; i < CONFIG.target_usernames.length; i++) {
            const username = CONFIG.target_usernames[i];
            console.log(`\n${"=".repeat(60)}`);
            console.log(`🎯 Memulai Akun: @${username} (${i + 1}/${CONFIG.target_usernames.length})`);
            console.log(`${"=".repeat(60)}`);
            
            await loadExistingData(username);
            
            // ========== DETECT MODE: First Run atau Maintenance ==========
            const mode = detectScrapingMode(username);
            
            if (mode === 'first_run') {
                console.log(`\n┌${"─".repeat(58)}┐`);
                console.log(`│ 🆕 MODE: FIRST RUN (Historical 5-Year Scraping)         │`);
                console.log(`│ Target: All posts from Nov 2020 - Nov 2025              │`);
                console.log(`│ Expected: 500-2000 posts per account                     │`);
                console.log(`└${"─".repeat(58)}┘\n`);
            } else {
                console.log(`\n┌${"─".repeat(58)}┐`);
                console.log(`│ 🔄 MODE: MAINTENANCE (Quick Update)                     │`);
                console.log(`│ Task: Check new posts + update engagement (≤7 days)     │`);
                console.log(`│ Expected: 1-20 new posts per account                     │`);
                console.log(`└${"─".repeat(58)}┘\n`);
            }
            
            // ========== SCRAPING LOOP (Bisa multiple batch untuk first run) ==========
            let continueScrapingThisAccount = true;
            let roundNumber = 1;
            
            while (continueScrapingThisAccount) {
                console.log(`\n${"-".repeat(60)}`);
                
                if (mode === 'first_run') {
                    console.log(`📦 BATCH ${roundNumber} - FIRST RUN untuk @${username}`);
                } else {
                    console.log(`🔄 MAINTENANCE CHECK untuk @${username}`);
                }
                
                console.log(`${"-".repeat(60)}`);
                
                // 1. Scroll profil (mode-aware)
                const newPostsFound = await scrapeProfile(page, username, mode);
                
                await debugPause(page, `Batch ${roundNumber} scroll selesai. New posts: ${newPostsFound}`, 'profile');
                
                // 2. Proses detail post
                await scrapePostDetails(page, username);
                
                // 3. Cek status
                const unprocessedPosts = Array.from(allPosts.values()).filter(
                    p => p.author_username === username && !p._processed_details
                );
                
                const totalPosts = Array.from(allPosts.values()).filter(
                    p => p.author_username === username
                ).length;
                
                console.log(`\n📊 STATUS @${username}:`);
                console.log(`   ✅ ${mode === 'first_run' ? 'Batch' : 'Check'} ${roundNumber} selesai`);
                console.log(`   📝 Total posts: ${totalPosts}`);
                console.log(`   📝 Unprocessed: ${unprocessedPosts.length}`);
                console.log(`   📊 Batch limiter: ${batchLimiter.getStatus()}`);
                
                // 4. Decide: Continue atau Stop?
                
                if (mode === 'maintenance') {
                    // MAINTENANCE MODE: 1 loop cukup!
                    console.log(`\n✅ MAINTENANCE COMPLETE untuk @${username}`);
                    continueScrapingThisAccount = false;
                    
                } else {
                    // FIRST RUN MODE: Continue sampai cutoff atau tidak ada post baru
                    
                    if (newPostsFound === 0 && unprocessedPosts.length === 0) {
                        console.log(`\n✅ FIRST RUN COMPLETE untuk @${username}!`);
                        console.log(`   📊 Total historical posts (5 years): ${totalPosts}`);
                        continueScrapingThisAccount = false;
                        
                    } else if (unprocessedPosts.length === 0 && newPostsFound > 0) {
                        console.log(`\n🔄 Masih ada post, lanjut batch berikutnya...`);
                        roundNumber++;
                        await page.waitForTimeout(5000);
                        
                    } else {
                        // Safety: Max 20 batch untuk first run
                        if (roundNumber >= 20) {
                            console.log(`\n⚠️  Reached max 20 batches, stopping.`);
                            console.log(`   💡 Tip: Jika belum sampai cutoff, jalankan lagi (akan resume)`);
                            continueScrapingThisAccount = false;
                        } else {
                            roundNumber++;
                        }
                    }
                }
            }
            
            // Jeda antar akun
            if (i < CONFIG.target_usernames.length - 1) {
                const delay = mode === 'first_run' ? 60 : 30; // First run = 1 menit jeda
                console.log(`\n⏳ Jeda ${delay} detik sebelum akun berikutnya...`);
                await page.waitForTimeout(delay * 1000);
            }
        }

        console.log(`\n${"=".repeat(60)}`);
        console.log(`✅ SEMUA PEKERJAAN SELESAI.`);
        console.log(`   Total Postingan unik didata: ${allPosts.size}`);
        console.log(`   Total Komentar unik didata: ${allComments.size}`);
        console.log(`   Data disimpan di folder: ${CONFIG.output_folder}`);
        console.log(`${"=".repeat(60)}`);

        await context.close();

    } catch (error) {
        console.error(`❌ Terjadi error fatal:`, error);
        if (browser) await browser.close();
    }
}

// ========== FUNGSI LOGIN & CEK LOGIN ==========
// (Tidak ada perubahan, sama seperti sebelumnya)
async function checkLogin(page) {
    try {
        console.log("Verifikasi login...");
        await page.goto("https://www.instagram.com/", { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        await page.waitForSelector('svg[aria-label="Home"], svg[aria-label="Search"]', { timeout: 7000 });
        console.log("✅ Sudah login (menggunakan sesi tersimpan).");
        return true;
    } catch (e) {
        console.log("⚠️ Belum login.");
        return false;
    }
}

async function loginToInstagram(page, username, password) {
    try {
        await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        
        await page.locator('input[name="username"]').fill(username);
        await page.waitForTimeout(1000);
        await page.locator('input[name="password"]').fill(password);
        await page.waitForTimeout(1000);
        await page.locator('button[type="submit"]').click();

        await page.waitForSelector('svg[aria-label="Home"]', { timeout: 60000 });
        console.log("✅ Login berhasil.");
        
        await page.waitForTimeout(3000);
        try {
            const notNowButton = page.locator('button:has-text("Not Now")').first();
            if (await notNowButton.count() > 0) {
                await notNowButton.click();
                console.log("   > Menutup pop-up 'Save Info'.");
            }
        } catch (e) {}
        
        return true;
    } catch (error) {
        console.error(`❌ Login gagal: ${error.message}`);
        return false;
    }
}

// ========== INTI SCRAPER: PENDENGAR (LISTENER) API (v3 - FIXED 4 API TYPES) ==========
function setupApiListeners(page) {
    console.log("[SETUP] Memasang pendengar API...");
    
    page.on('response', async (response) => {
        const url = response.url();
        
        try {
            // Filter hanya API yang relevan
            if (!url.includes('/api/v1/media/') && !url.includes('/graphql/query')) {
                return;
            }
            
            // --- API 1: Data Postingan (dari Halaman Profil) ---
            if (url.includes('/graphql/query')) {
                const responseText = await response.text();
                
                if (responseText.includes('xdt_api__v1__feed__user_timeline_graphql_connection')) {
                    const json = JSON.parse(responseText);
                    const posts = json.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges || [];
                    
                    if (posts.length === 0) return;
                    
                    console.log(`[API 1] ✅ Ditemukan ${posts.length} postingan dari profil`);
                    
                    for (const edge of posts) {
                        const post = edge.node;
                        const post_pk = post.pk;
                        
                        // ========== FILTER: 5 TAHUN CUTOFF ==========
                        if (CONFIG.MAX_POST_AGE_DAYS) {
                            const now = Date.now() / 1000; // Current time in seconds
                            const postAge = now - post.taken_at; // Age in seconds
                            const maxAge = CONFIG.MAX_POST_AGE_DAYS * 86400; // 5 years in seconds
                            
                            if (postAge > maxAge) {
                                // Post lebih tua dari 5 tahun, SKIP!
                                const postDate = new Date(post.taken_at * 1000);
                                console.log(`[API 1] ⏸️  CUTOFF: Post from ${postDate.toLocaleDateString('id-ID')} (${Math.round(postAge / 86400)} days old, max ${CONFIG.MAX_POST_AGE_DAYS})`);
                                continue;
                            }
                        }
                        
                        if (!allPosts.has(post_pk)) {
                            allPosts.set(post_pk, {
                                post_pk: post_pk,
                                post_code: post.code,
                                post_url: `https://www.instagram.com/p/${post.code}/`,
                                author_username: post.user.username,
                                caption: post.caption?.text || "",
                                timestamp_unix: post.taken_at,
                                like_count: post.like_count,
                                comment_count: post.comment_count,
                                view_count: 0,
                                share_count: "N/A",
                                location: post.location?.name || "N/A",  // ← TAMBAH INI!
                                _processed_details: false
                            });
                        }
                    }
                }
            }
            
            // --- API 2: Info Detail Postingan (VIEW COUNT + LOCATION + AUDIO!) ---
            else if (url.includes('/api/v1/media/') && url.includes('/info/')) {
                const json = await response.json();
                const post = json.items?.[0];
                
                if (!post) return;
                
                const post_pk = post.pk;
                const view_count = post.play_count || 0;
                
                console.log(`[API 2] 👁️  Post ${post.code} → Views: ${view_count.toLocaleString()}`);
                
                if (allPosts.has(post_pk)) {
                    const existingPost = allPosts.get(post_pk);
                    
                    // ========== UPDATE ENGAGEMENT ==========
                    existingPost.view_count = view_count;
                    existingPost.like_count = post.like_count || existingPost.like_count;
                    existingPost.comment_count = post.comment_count || existingPost.comment_count;
                    
                    // ========== UPDATE LOCATION (jika ada di API) ==========
                    if (post.location?.name && existingPost.location === "N/A") {
                        existingPost.location = post.location.name;
                        console.log(`         📍 Location from API: ${post.location.name}`);
                    }
                    
                    // ========== UPDATE AUDIO SOURCE (jika ada di API) ==========
                    // Try multiple API structures (Instagram suka ganti-ganti struktur)
                    let audioFromAPI = null;
                    
                    // Structure 1: music_info (common for reels)
                    if (post.music_info?.music_asset_info) {
                        const artist = post.music_info.music_asset_info.display_artist || "";
                        const title = post.music_info.music_asset_info.title || "";
                        
                        if (artist && !artist.toLowerCase().includes('original audio')) {
                            audioFromAPI = title ? `${artist} - ${title}` : artist;
                        }
                    }
                    
                    // Structure 2: clips_metadata (alternative for reels)
                    else if (post.clips_metadata?.music_info?.music_asset_info) {
                        const artist = post.clips_metadata.music_info.music_asset_info.display_artist || "";
                        const title = post.clips_metadata.music_info.music_asset_info.title || "";
                        
                        if (artist && !artist.toLowerCase().includes('original audio')) {
                            audioFromAPI = title ? `${artist} - ${title}` : artist;
                        }
                    }
                    
                    // Structure 3: original_sound_info (for original audio with name)
                    else if (post.original_sound_info?.audio_asset_id) {
                        const audioName = post.original_sound_info.progressive_download_url || "";
                        // Skip this as it's usually original audio
                    }
                    
                    // Update jika dapat dari API dan belum ada
                    if (audioFromAPI && existingPost.audio_source === "N/A") {
                        existingPost.audio_source = audioFromAPI;
                        console.log(`         🎵 Audio from API: ${audioFromAPI.substring(0, 50)}${audioFromAPI.length > 50 ? '...' : ''}`);
                    }
                    
                    existingPost._processed_details = true;
                }
            }
            
            // --- API 3A & 3B: KOMENTAR INDUK (Initial + Pagination) ---
            else if (url.includes('/api/v1/media/') && url.includes('/comments/') && !url.includes('/child_comments/')) {
                const json = await response.json();
                const comments = json.comments || [];
                
                if (comments.length === 0) return;
                
                // Extract post_pk dari URL
                const match = url.match(/\/api\/v1\/media\/(.*?)\/comments/);
                if (!match) return;
                
                const post_pk = match[1].split('/')[0];
                const has_more = json.has_more_comments || false;
                const next_token = json.next_min_id || null;
                const total_count = json.comment_count || 0;
                
                // SIMPAN STATE PAGINATION
                commentPaginationState.set(post_pk, {
                    next_min_id: next_token,
                    has_more: has_more
                });
                
                console.log(`[API 3] 💬 Post ${post_pk}: +${comments.length} komentar | Total: ${total_count} | Has More: ${has_more}`);
                
                // Simpan komentar
                for (const comment of comments) {
                    const comment_pk = comment.pk;
                    
                    if (!allComments.has(comment_pk)) {
                        allComments.set(comment_pk, {
                            post_pk: post_pk,
                            comment_pk: comment_pk,
                            comment_author: comment.user.username,
                            comment_text: comment.text,
                            comment_likes: comment.comment_like_count,
                            comment_timestamp_unix: comment.created_at,
                            child_comment_count: comment.child_comment_count || 0,
                            parent_comment_pk: null,
                        });
                    }
                }
            }
            
            // --- API 4: CHILD COMMENTS (Balasan) ---
            else if (url.includes('/child_comments/')) {
                const json = await response.json();
                const childComments = json.child_comments || [];
                
                if (childComments.length === 0) return;
                
                // Extract post_pk dan parent_comment_pk dari URL
                const match = url.match(/\/api\/v1\/media\/(.*?)\/comments\/(.*?)\/child_comments/);
                if (!match) return;
                
                const post_pk = match[1];
                const parent_pk = match[2];
                
                console.log(`[API 4] 💬💬 Post ${post_pk}: +${childComments.length} balasan untuk komentar ${parent_pk}`);
                
                // Simpan balasan
                for (const comment of childComments) {
                    const comment_pk = comment.pk;
                    
                    if (!allComments.has(comment_pk)) {
                        allComments.set(comment_pk, {
                            post_pk: post_pk,
                            comment_pk: comment_pk,
                            comment_author: comment.user.username,
                            comment_text: comment.text,
                            comment_likes: comment.comment_like_count,
                            comment_timestamp_unix: comment.created_at,
                            child_comment_count: 0,
                            parent_comment_pk: parent_pk,
                        });
                    }
                }
            }
            
        } catch (e) {
            // Silent fail untuk parsing error
        }
    });
}

// ========== PROSES SCRAPING ==========

// ========== SCRAPE PROFILE (v2 - Mode Aware: First Run vs Maintenance) ==========
async function scrapeProfile(page, username, mode) {
    if (mode === 'maintenance') {
        console.log(`[SCROLL] 🔄 MAINTENANCE MODE: Cek post baru saja...`);
    } else {
        console.log(`[SCROLL] 📥 FIRST RUN: Ambil 5 tahun post history...`);
    }
    
    const profileUrl = `https://www.instagram.com/${username}/`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    
    // Hitung post sebelum scroll
    const postCountBefore = Array.from(allPosts.values()).filter(
        p => p.author_username === username
    ).length;
    
    // ========== MAINTENANCE MODE: MINIMAL SCROLL ==========
    if (mode === 'maintenance') {
        console.log(`   > Maintenance: Scroll minimal (cek ${CONFIG.MAINTENANCE_MODE.MAX_NEW_POSTS_TO_CHECK} post terbaru)`);
        
        // Scroll 2-3 kali saja (cukup untuk load 30-50 post terbaru)
        for (let i = 0; i < 3; i++) {
            console.log(`   > Scroll [${i + 1}/3]...`);
            await page.keyboard.press('End');
            await page.waitForTimeout(2000);
        }
        
        const postCountAfter = Array.from(allPosts.values()).filter(
            p => p.author_username === username
        ).length;
        
        const newPostsFound = postCountAfter - postCountBefore;
        console.log(`[SCROLL] ✅ Maintenance: ${newPostsFound} post baru ditemukan`);
        
        return newPostsFound;
    }
    
    // ========== FIRST RUN MODE: SCROLL SAMPAI CUTOFF (5 TAHUN) ==========
    console.log(`   > First Run: Scroll sampai cutoff 5 tahun (Nov 2020)...`);
    
    let lastHeight = 0;
    let scrollAttempts = 0;
    let hitCutoff = false;
    
    for (let i = 0; i < CONFIG.MAX_PROFILE_SCROLLS; i++) {
        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        
        // Cek apakah ada post yang hit cutoff
        const userPosts = Array.from(allPosts.values()).filter(
            p => p.author_username === username
        );
        
        if (userPosts.length > 0) {
            const oldestPost = userPosts.reduce((oldest, post) => {
                return post.timestamp_unix < oldest.timestamp_unix ? post : oldest;
            });
            
            const postAge = (Date.now() / 1000 - oldestPost.timestamp_unix) / 86400; // days
            
            if (postAge >= CONFIG.MAX_POST_AGE_DAYS) {
                console.log(`   > ✅ CUTOFF REACHED! Oldest post: ${Math.round(postAge)} days (limit: ${CONFIG.MAX_POST_AGE_DAYS})`);
                hitCutoff = true;
                break;
            }
        }
        
        if (newHeight === lastHeight) {
            scrollAttempts++;
            if (scrollAttempts >= 3) {
                console.log("   > ✅ Reached end of profile");
                break;
            }
        } else {
            scrollAttempts = 0;
        }
        
        lastHeight = newHeight;
        
        console.log(`   > Scroll [${i + 1}/${CONFIG.MAX_PROFILE_SCROLLS}] - Posts: ${userPosts.length}`);
        await page.keyboard.press('End');
        await page.waitForTimeout(3000);
    }
    
    const postCountAfter = Array.from(allPosts.values()).filter(
        p => p.author_username === username
    ).length;
    
    const newPostsFound = postCountAfter - postCountBefore;
    
    if (hitCutoff) {
        console.log(`[SCROLL] ✅ First Run Complete: ${newPostsFound} posts (5-year history) - CUTOFF REACHED`);
    } else {
        console.log(`[SCROLL] ✅ First Run: ${newPostsFound} posts collected`);
    }
    
    return newPostsFound;
}

// ========== HELPER: CLEAR HOVER OVERLAY (dari code lama) ==========
async function clearHoverOverlay(page) {
    try {
        await page.mouse.move(5, 5);
        await page.waitForTimeout(300);
        await page.mouse.click(5, 5);
        await page.waitForTimeout(300);
        return true;
    } catch (e) {
        return false;
    }
}

// ========== CHECK IF POST NEEDS UPDATE (v2 - GRADUAL DECAY + SPIKE DETECTION) ==========
function shouldUpdateEngagement(postData) {
    if (!CONFIG.ENABLE_ENGAGEMENT_UPDATE) {
        return { shouldUpdate: false, reason: 'Update disabled', category: 'disabled' };
    }
    
    // ========== WAKTU REAL-TIME (WIB) ==========
    const now = Date.now();
    const postTime = postData.timestamp * 1000; // Unix to milliseconds
    const lastUpdate = postData.updated_at ? new Date(postData.updated_at).getTime() : postTime;
    
    const hoursSincePost = (now - postTime) / (1000 * 60 * 60);
    const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);
    const daysSincePost = hoursSincePost / 24;
    
    // ========== PHASE 4: ARCHIVE (>7 hari) - STOP! ==========
    if (daysSincePost > CONFIG.UPDATE_SCHEDULE.MAX_UPDATE_AGE_DAYS) {
        return { 
            shouldUpdate: false, 
            reason: `Archive (${Math.round(daysSincePost)}d old, stopped tracking)`,
            category: 'archive'
        };
    }
    
    // ========== SMART SPIKE DETECTION (Priority Check!) ==========
    if (CONFIG.UPDATE_SCHEDULE.ENABLE_SPIKE_DETECTION && postData.update_count > 0) {
        const lastLikes = postData.likes || 0;
        const lastComments = postData.comments || 0;
        const lastViews = postData.views || 0;
        
        // Hitung total engagement terakhir
        const lastEngagement = lastLikes + (lastComments * 5) + (lastViews * 0.1);
        
        // Ambil engagement dari update sebelumnya (jika ada)
        if (postData._previous_engagement) {
            const growthRate = ((lastEngagement - postData._previous_engagement) / postData._previous_engagement) * 100;
            
            if (growthRate > CONFIG.UPDATE_SCHEDULE.SPIKE_THRESHOLD) {
                // VIRAL SPIKE DETECTED!
                if (hoursSinceUpdate >= CONFIG.UPDATE_SCHEDULE.SPIKE_UPDATE_EVERY) {
                    return {
                        shouldUpdate: true,
                        reason: `🔥 VIRAL SPIKE! (+${Math.round(growthRate)}% growth, update every ${CONFIG.UPDATE_SCHEDULE.SPIKE_UPDATE_EVERY}h)`,
                        category: 'viral_spike',
                        updateFrequency: CONFIG.UPDATE_SCHEDULE.SPIKE_UPDATE_EVERY
                    };
                } else {
                    return {
                        shouldUpdate: false,
                        reason: `Spike detected but updated ${Math.round(hoursSinceUpdate)}h ago (next in ${Math.round(CONFIG.UPDATE_SCHEDULE.SPIKE_UPDATE_EVERY - hoursSinceUpdate)}h)`,
                        category: 'viral_spike_waiting'
                    };
                }
            }
        }
    }
    
    // ========== PRIME TIME CHECK (Optional) ==========
    if (CONFIG.PRIME_TIME_UPDATE.ENABLED) {
        const currentHour = new Date(now + (CONFIG.TIMEZONE_OFFSET * 60 * 60 * 1000)).getUTCHours();
        const isPrimeTime = currentHour >= CONFIG.PRIME_TIME_UPDATE.START_HOUR && 
                           currentHour <= CONFIG.PRIME_TIME_UPDATE.END_HOUR;
        
        if (!isPrimeTime && hoursSinceUpdate < 2) {
            // Skip update jika di luar prime time dan baru update < 2 jam
            return {
                shouldUpdate: false,
                reason: `Outside prime time (${currentHour}:00 WIB), next update during active hours`,
                category: 'outside_prime_time'
            };
        }
    }
    
    // ========== PHASE 1: GOLDEN WINDOW (0-24 jam) - VIRAL DETECTION! ==========
    if (hoursSincePost < CONFIG.UPDATE_SCHEDULE.GOLDEN_WINDOW_HOURS) {
        if (hoursSinceUpdate >= CONFIG.UPDATE_SCHEDULE.GOLDEN_UPDATE_EVERY) {
            return { 
                shouldUpdate: true, 
                reason: `Golden Window (${Math.round(hoursSincePost)}h old, update every ${CONFIG.UPDATE_SCHEDULE.GOLDEN_UPDATE_EVERY}h)`,
                category: 'golden',
                updateFrequency: CONFIG.UPDATE_SCHEDULE.GOLDEN_UPDATE_EVERY
            };
        } else {
            return {
                shouldUpdate: false,
                reason: `Golden Window but updated ${Math.round(hoursSinceUpdate)}h ago (next in ${Math.round(CONFIG.UPDATE_SCHEDULE.GOLDEN_UPDATE_EVERY - hoursSinceUpdate)}h)`,
                category: 'golden_waiting'
            };
        }
    }
    
    // ========== PHASE 2: MOMENTUM (1-3 hari) - GROWTH TRACKING ==========
    if (daysSincePost < CONFIG.UPDATE_SCHEDULE.MOMENTUM_WINDOW_DAYS) {
        if (hoursSinceUpdate >= CONFIG.UPDATE_SCHEDULE.MOMENTUM_UPDATE_EVERY) {
            return { 
                shouldUpdate: true, 
                reason: `Momentum Phase (${Math.round(daysSincePost)}d old, update every ${CONFIG.UPDATE_SCHEDULE.MOMENTUM_UPDATE_EVERY}h)`,
                category: 'momentum',
                updateFrequency: CONFIG.UPDATE_SCHEDULE.MOMENTUM_UPDATE_EVERY
            };
        } else {
            return {
                shouldUpdate: false,
                reason: `Momentum phase but updated ${Math.round(hoursSinceUpdate)}h ago (next in ${Math.round(CONFIG.UPDATE_SCHEDULE.MOMENTUM_UPDATE_EVERY - hoursSinceUpdate)}h)`,
                category: 'momentum_waiting'
            };
        }
    }
    
    // ========== PHASE 3: STABILIZATION (3-7 hari) - FINAL METRICS ==========
    if (daysSincePost < CONFIG.UPDATE_SCHEDULE.STABILIZATION_WINDOW_DAYS) {
        if (hoursSinceUpdate >= CONFIG.UPDATE_SCHEDULE.STABILIZATION_UPDATE_EVERY) {
            return { 
                shouldUpdate: true, 
                reason: `Stabilization (${Math.round(daysSincePost)}d old, update every ${CONFIG.UPDATE_SCHEDULE.STABILIZATION_UPDATE_EVERY}h)`,
                category: 'stabilization',
                updateFrequency: CONFIG.UPDATE_SCHEDULE.STABILIZATION_UPDATE_EVERY
            };
        } else {
            return {
                shouldUpdate: false,
                reason: `Stabilization but updated ${Math.round(hoursSinceUpdate)}h ago (next in ${Math.round(CONFIG.UPDATE_SCHEDULE.STABILIZATION_UPDATE_EVERY - hoursSinceUpdate)}h)`,
                category: 'stabilization_waiting'
            };
        }
    }
    
    // Fallback (shouldn't reach here)
    return { 
        shouldUpdate: false, 
        reason: `Unknown state (${Math.round(daysSincePost)}d old)`,
        category: 'unknown'
    };
}

// ========== LOAD EXISTING POST DATA ==========
async function loadExistingPostData(postUrl) {
    const cleanUrl = postUrl.split('?')[0];
    
    const jsonFile = getPostsJSONFilename();  // ← Tidak ada username
    if (fs.existsSync(jsonFile)) {
        try {
            const content = fs.readFileSync(jsonFile, 'utf8');
            const postsData = JSON.parse(content);
            const existingPost = postsData.find(p => p.post_url === cleanUrl);
            
            if (existingPost) {
                return existingPost;
            }
        } catch (e) {}
    }
    
    return null;
}

// ========== EXTRACT LOCATION MANUAL (Fallback jika API tidak ada) ==========
async function extractLocationManual(postContainer, page) {
    try {
        console.log(`         🔍 Extracting location manually...`);
        
        const locationSelectors = [
            'a._aaqk._a6hd[href*="/explore/locations/"]',
            'a._aaqk[href*="/explore/locations/"]',
            'a[href*="/explore/locations/"]',
            'div._aaqm a[href*="/explore/locations/"]',
            'div.x78zum5 a[href*="/explore/locations/"]',
            'a[href^="/explore/locations/"]'  // ← Tambahan
        ];
        
        // ========== TRY 1: Immediate Check ==========
        for (const selector of locationSelectors) {
            const locationEl = postContainer.locator(selector).first();
            if (await locationEl.count() > 0) {
                const locationText = await locationEl.textContent();
                if (locationText && locationText.trim().length > 0 && locationText.trim().length < 100) {
                    const cleaned = cleanTextForCSV(locationText.trim());
                    console.log(`            ✅ Found immediately: ${cleaned}`);
                    return cleaned;
                }
            }
        }
        
        // ========== TRY 2: Wait & Retry (Lazy Loading) ==========
        console.log(`            ⏳ Not immediately visible, waiting...`);
        
        const maxAttempts = Math.ceil(CONFIG.LOCATION_WAIT_SECONDS / 2);  // 12s ÷ 2 = 6 attempts
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await page.waitForTimeout(2000);  // Wait 2 seconds
            
            for (const selector of locationSelectors) {
                const locationEl = postContainer.locator(selector).first();
                if (await locationEl.count() > 0) {
                    const locationText = await locationEl.textContent();
                    if (locationText && locationText.trim().length > 0 && locationText.trim().length < 100) {
                        const cleaned = cleanTextForCSV(locationText.trim());
                        console.log(`            ✅ Found after ${attempt * 2}s: ${cleaned}`);
                        return cleaned;
                    }
                }
            }
            
            if (attempt < maxAttempts) {
                console.log(`            ⏳ Attempt ${attempt}/${maxAttempts}...`);
            }
        }
        
        console.log(`            ⚠️ Not found after ${CONFIG.LOCATION_WAIT_SECONDS}s`);
        return "N/A";
        
    } catch (e) {
        console.log(`            ❌ Error: ${e.message.substring(0, 40)}`);
        return "N/A";
    }
}

// ========== EXTRACT AUDIO SOURCE (Skip "Original Audio"!) ==========
async function extractAudioSource(postContainer, page) {
    try {
        console.log(`         🎵 Extracting audio source...`);
        
        const audioSelectors = [
            'a[href*="/reels/audio/"]',                    // Primary
            'div._aaql a[href*="/reels/audio/"]',          // Inside audio container
            'div._ac7v a[href*="/reels/audio/"]',          // Alternative container
            'a[href^="/reels/audio/"]',                    // Starts with
        ];
        
        for (const selector of audioSelectors) {
            const audioLink = postContainer.locator(selector).first();
            
            if (await audioLink.count() > 0) {
                // Get text content
                const audioText = await audioLink.textContent();
                
                if (!audioText || audioText.trim().length === 0) {
                    continue;
                }
                
                const cleaned = cleanTextForCSV(audioText.trim());
                
                // ========== FILTERING LOGIC ==========
                
                // 1. Skip "Original audio" (case insensitive)
                if (cleaned.toLowerCase().includes('original audio')) {
                    console.log(`            ⏭️  Skipped: Original audio`);
                    return "N/A";
                }
                
                // 2. Skip "Audio asli" (Indonesian)
                if (cleaned.toLowerCase().includes('audio asli')) {
                    console.log(`            ⏭️  Skipped: Audio asli`);
                    return "N/A";
                }
                
                // 3. Skip jika terlalu pendek (< 3 karakter)
                if (cleaned.length < 3) {
                    console.log(`            ⏭️  Skipped: Too short (${cleaned.length} chars)`);
                    continue;
                }
                
                // 4. Skip jika terlalu panjang (> 150 karakter, kemungkinan error)
                if (cleaned.length > 150) {
                    console.log(`            ⚠️  Warning: Very long audio name (${cleaned.length} chars), truncating...`);
                    const truncated = cleaned.substring(0, 150) + "...";
                    console.log(`            ✅ Found (truncated): ${truncated}`);
                    return truncated;
                }
                
                // ========== VALID AUDIO SOURCE! ==========
                console.log(`            ✅ Found: ${cleaned}`);
                return cleaned;
            }
        }
        
        // ========== FALLBACK: Try with wait (lazy loading) ==========
        console.log(`            ⏳ Audio not immediately visible, waiting 2s...`);
        await page.waitForTimeout(2000);
        
        // Retry once more
        for (const selector of audioSelectors) {
            const audioLink = postContainer.locator(selector).first();
            
            if (await audioLink.count() > 0) {
                const audioText = await audioLink.textContent();
                
                if (audioText && audioText.trim().length >= 3) {
                    const cleaned = cleanTextForCSV(audioText.trim());
                    
                    if (!cleaned.toLowerCase().includes('original audio') && 
                        !cleaned.toLowerCase().includes('audio asli')) {
                        console.log(`            ✅ Found after wait: ${cleaned}`);
                        return cleaned;
                    }
                }
            }
        }
        
        console.log(`            ℹ️  No audio source (static image post or original audio)`);
        return "N/A";
        
    } catch (e) {
        console.log(`            ❌ Error: ${e.message.substring(0, 40)}`);
        return "N/A";
    }
}

// ========== PROSES DETAIL POST: SMART UPDATE + SKIP ZERO COMMENTS ==========
async function scrapePostDetails(page, username) {
    console.log(`[TAHAP 2] 📥 Mengambil detail & komentar untuk @${username}...`);
    
    const postsToScrape = Array.from(allPosts.values()).filter(
        p => p.author_username === username && !p._processed_details
    );
    
    if (postsToScrape.length === 0) {
        console.log("[TAHAP 2] ✅ Semua postingan sudah diproses.");
        return;
    }
    
    console.log(`   > 🎯 Akan memproses ${postsToScrape.length} postingan baru...`);
    console.log(`   > 📊 Batch status: ${batchLimiter.getStatus()}\n`);
    
    // Kembali ke halaman profil
    const profileUrl = `https://www.instagram.com/${username}/`;
    console.log(`   🔙 Kembali ke profil: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    
    for (let i = 0; i < postsToScrape.length; i++) {
        const post = postsToScrape[i];
        
        console.log(`\n   📍 [${i + 1}/${postsToScrape.length}] ${post.post_code}`);
        
        // ========== CHECK IF POST EXISTS (FOR UPDATE LOGIC) ==========
        const existingPost = await loadExistingPostData(post.post_url);
        
        let isUpdate = false;
        let updateReason = '';
        
        if (existingPost) {
            const updateCheck = shouldUpdateEngagement(existingPost);
            
            if (updateCheck.shouldUpdate) {
                isUpdate = true;
                updateReason = updateCheck.reason;
                console.log(`      🔄 UPDATE MODE: ${updateReason}`);
            } else {
                console.log(`      ⏭️  SKIP: ${updateCheck.reason}`);
                
                if (allPosts.has(post.post_pk)) {
                    allPosts.get(post.post_pk)._processed_details = true;
                }
                
                continue;
            }
        }
        
        try {
            // ========== FIND & CLICK POST ==========
            const postLink = page.locator(`a[href*="/${post.post_code}/"]`).first();
            
            if (await postLink.count() === 0) {
                console.log(`      ⚠️ Post tidak ditemukan, scroll untuk cari...`);
                
                for (let scrollAttempt = 0; scrollAttempt < 5; scrollAttempt++) {
                    await page.keyboard.press('End');
                    await page.waitForTimeout(2000);
                    
                    if (await postLink.count() > 0) break;
                }
                
                if (await postLink.count() === 0) {
                    console.log(`      ❌ Post tidak ditemukan, skip`);
                    continue;
                }
            }
            
            console.log(`      🎯 Scroll ke post...`);
            await postLink.scrollIntoViewIfNeeded({ timeout: 5000 });
            await page.waitForTimeout(1000);
            
            // Highlight
            await postLink.evaluate(el => {
                el.style.outline = '8px solid #FFD700';
                el.style.boxShadow = '0 0 30px rgba(255,215,0,0.8)';
            }).catch(() => {});
            await page.waitForTimeout(500);
            
            console.log(`      🖱️  Klik post...`);
            await postLink.click({ timeout: 5000 }).catch(() => 
                postLink.click({ force: true, timeout: 5000 })
            );
            
            await page.waitForTimeout(4000);
            
            // Verify opened
            try {
                await page.waitForSelector('article, div[role="dialog"]', { timeout: 10000 });
                console.log(`      ✅ Post terbuka!`);
            } catch (e) {
                console.log(`      ❌ Gagal buka post, skip`);
                continue;
            }
            
            // ========== EXTRACT DATA LENGKAP ==========
            const postContainer = page.locator('article, div[role="dialog"]').first();
            
            console.log(`\n      📝 EXTRACTING DATA...`);
            
            // 1. Author(s) - HANDLE MULTIPLE AUTHORS!
            let author = post.author_username;
            let authorProfileLink = `https://www.instagram.com/${author}/`;

            // ========== DETECT MULTIPLE AUTHORS (Collaboration Post) ==========
            try {
                console.log(`         👤 Checking for multiple authors...`);
                
                // Selector untuk multiple authors (Instagram collaboration)
                const multiAuthorSelector = 'div._aar0 a._a6hd[href^="/"], header a[href^="/"]';
                const multiAuthorLinks = await postContainer.locator(multiAuthorSelector).all();
                
                let allAuthors = [];
                let allAuthorLinks = [];
                
                for (const link of multiAuthorLinks) {
                    const href = await link.getAttribute('href');
                    if (href && href.match(/^\/[a-zA-Z0-9._]+\/?$/)) {
                        const username = href.replace(/\//g, '').trim();
                        
                        // Skip invalid usernames
                        if (username === 'explore' || 
                            username.includes('locations') || 
                            username.includes('audio') ||
                            username.includes('reels') ||
                            username.length === 0) {
                            continue;
                        }
                        
                        // Avoid duplicates
                        if (!allAuthors.includes(username)) {
                            allAuthors.push(username);
                            allAuthorLinks.push(`https://www.instagram.com/${username}/`);
                        }
                    }
                }
                
                // If multiple authors found, join them
                if (allAuthors.length > 1) {
                    author = allAuthors.join(' & ');  // ← "user1 & user2"
                    authorProfileLink = allAuthorLinks.join(' & ');  // ← "link1 & link2"
                    console.log(`         ✅ Multiple authors: ${author}`);
                } else if (allAuthors.length === 1) {
                    author = allAuthors[0];
                    authorProfileLink = `https://www.instagram.com/${author}/`;
                    console.log(`         ✅ Single author: ${author}`);
                } else {
                    // Fallback to post.author_username
                    console.log(`         ✅ Author from API: ${author}`);
                }
                
            } catch (e) {
                console.log(`         ⚠️ Author extraction error: ${e.message.substring(0, 30)}`);
                // Keep using post.author_username as fallback
            }
            
            // 2. Location (Hybrid: API → Manual Extraction)
            let location = "N/A";
            // ← LAYER 1: Cek dari API dulu (cepat!)
            const currentPost = allPosts.get(post.post_pk);  // ← DEKLARASI UTAMA (dipakai di banyak tempat)
            if (currentPost && currentPost.location && currentPost.location !== "N/A") {
                location = cleanTextForCSV(currentPost.location);
                console.log(`         ✅ Location from API: ${location}`);
            }

            // ← LAYER 2: Kalau API kosong, extract manual (dari code lama!)
            if (location === "N/A") {
                // Cek dari existingPost dulu (kalau update mode)
                if (existingPost?.location && existingPost.location !== "N/A") {
                    location = existingPost.location;
                    console.log(`         ✅ Location from cache: ${location}`);
                } else {
                    // Manual extraction (pakai fungsi baru)
                    location = await extractLocationManual(postContainer, page);
                }
            }
            
            // 3. Audio Source (for reels/videos - IMPROVED!)
            let audioSource = existingPost?.audio_source || "N/A";
            // Only extract for reel/video posts
            if (post.post_url.includes('/reel/')) {  // ← CUKUP CEK URL SAJA!
                try {
                    // Try multiple selectors (fallback)
                    const audioSelectors = [
                        'a[href*="/reels/audio/"]',
                        'div._aaql a[href*="/reels/audio/"]'
                    ];
                    
                    for (const selector of audioSelectors) {
                        const audioEl = postContainer.locator(selector).first();
                        if (await audioEl.count() > 0) {
                            const audioText = await audioEl.textContent();
                            
                            // Validate audio text
                            if (audioText && audioText.trim().length > 0) {
                                const trimmed = audioText.trim();
                                
                                // ========== FILTERING ==========
                                // Skip "Original audio" (English)
                                if (trimmed.toLowerCase().includes('original audio')) {
                                    console.log(`            ⏭️  Audio: Original audio (skipped)`);
                                    audioSource = "N/A";
                                    break;
                                }
                                
                                // Skip "Audio asli" (Indonesian)
                                if (trimmed.toLowerCase().includes('audio asli')) {
                                    console.log(`            ⏭️  Audio: Audio asli (skipped)`);
                                    audioSource = "N/A";
                                    break;
                                }
                                
                                // Skip if too short (likely error)
                                if (trimmed.length < 3) {
                                    console.log(`            ⚠️  Audio: Too short (${trimmed.length} chars)`);
                                    continue;
                                }
                                
                                // ========== VALID AUDIO! ==========
                                audioSource = cleanTextForCSV(trimmed);
                                console.log(`            ✅ Audio: ${audioSource.substring(0, 50)}${audioSource.length > 50 ? '...' : ''}`);
                                break;
                            }
                        }
                    }
                } catch (e) {
                    console.log(`            ❌ Audio error: ${e.message.substring(0, 30)}`);
                }
                
                // Special handling untuk location di Reel
                if (location === "N/A") {
                    console.log(`         🎥 Reel detected, trying location extraction again...`);
                    await page.waitForTimeout(2000);
                    location = await extractLocationManual(postContainer, page);
                }
            }

            // 4. Caption
            let contentText = post.caption || existingPost?.content_text || "";
            
            // 5. Timestamp
            const timestampISO = unixToISO(post.timestamp_unix);
            const timestampWIB = convertToWIB(timestampISO);
            
            // 6. Image/Video URLs
            let imageUrl = existingPost?.image_url || "N/A";
            let videoUrl = existingPost?.video_url || "N/A";
            let imageSource = existingPost?.image_source || "N/A";
            
            if (post.post_url.includes('/reel/') || post.post_url.includes('video')) {
                videoUrl = post.post_url;
            } else {
                imageUrl = post.post_url;
                
                // Try extract image source
                if (!isUpdate || imageSource === "N/A") {
                    try {
                        const img = postContainer.locator('img[src*="scontent"]').first();
                        if (await img.count() > 0) {
                            imageSource = await img.getAttribute('src');
                        }
                    } catch (e) {}
                }
            }
            
            // 7. Engagement (UPDATED!)
            const likes = currentPost.like_count || 0;
            const comments = currentPost.comment_count || 0;
            const views = currentPost.view_count || 0;

            // ========== CALCULATE ENGAGEMENT SCORE (untuk spike detection) ==========
            const currentEngagement = likes + (comments * 5) + (views * 0.1);
            
            console.log(`         Author: ${author}`);
            console.log(`         Location: ${location}`);
            console.log(`         Likes: ${likes} | Comments: ${comments} | Views: ${views}`);
            
            if (isUpdate) {
                const oldLikes = existingPost.likes || 0;
                const oldComments = existingPost.comments || 0;
                const oldViews = existingPost.views || 0;
                
                
                console.log(`         📈 Change: L+${likes - oldLikes} | C+${comments - oldComments} | V+${views - oldViews}`);
            }
            
            // ========== EXTRACT COMMENTS (SMART SKIP!) ==========
            let extractedComments = [];
            let shouldExtractComments = true;
            
            // ← SKIP LOGIC: Zero comments
            if (CONFIG.SKIP_ZERO_COMMENTS && comments === 0) {
                console.log(`\n      ⏭️  SKIP COMMENTS: Post has 0 comments (hemat waktu!)`);
                shouldExtractComments = false;
            }
            
            // ← SKIP LOGIC: Update mode & no new comments
            if (isUpdate && existingPost.comments === comments) {
                console.log(`\n      ⏭️  SKIP COMMENTS: No new comments since last update`);
                shouldExtractComments = false;
            }
            
            if (shouldExtractComments) {
                console.log(`\n      💬 Extracting comments (max ${CONFIG.MAX_COMMENTS_PER_POST})...`);
                
                await scrollComments(page);
                await expandAllReplies(page);
                await page.waitForTimeout(2000);
                
                // Get comments from memory for this post
                extractedComments = Array.from(allComments.values())
                    .filter(c => c.post_pk === post.post_pk)
                    .slice(0, CONFIG.MAX_COMMENTS_PER_POST); // ← LIMIT 200!
                
                console.log(`         ✅ Scraped: ${extractedComments.length} comments`);
            }
            
            // ========== SAVE POST (REAL-TIME!) ==========
            const now = new Date().toISOString();
            
            const postData = {
                author: cleanTextForCSV(author),  // ← Clean!
                author_profile_link: authorProfileLink,  // URL tidak perlu clean
                location: cleanTextForCSV(location),  // ← Clean!
                audio_source: cleanTextForCSV(audioSource),  // ← Clean!
                timestamp: post.timestamp_unix,
                timestamp_iso: timestampISO,
                timestamp_wib: timestampWIB,
                post_url: post.post_url,  // URL tidak perlu clean
                content_text: cleanTextForCSV(contentText),  // ← CRITICAL: Clean caption!
                image_url: imageUrl,
                video_url: videoUrl,
                image_source: imageSource,
                video_source: "N/A",
                likes: likes,
                comments: comments,
                views: views,
                query_used: cleanTextForCSV(username),  // ← Clean!
                scraped_at: isUpdate ? existingPost.scraped_at : now,
                scraped_at_wib: isUpdate ? existingPost.scraped_at_wib : convertToWIB(now),
                updated_at: now,
                updated_at_wib: convertToWIB(now),
                update_count: isUpdate ? (existingPost.update_count || 0) + 1 : 0,
                _previous_engagement: isUpdate ? (existingPost.likes + (existingPost.comments * 5) + (existingPost.views * 0.1)) : currentEngagement  // ← TAMBAH INI!
            };
            
            await savePostRealtime(postData);
            
            // ========== SAVE COMMENTS (REAL-TIME!) ==========
            if (extractedComments.length > 0) {
                const commentsToSave = extractedComments.map(c => ({
                    post_url: post.post_url,
                    post_author: cleanTextForCSV(author),  // ← Clean!
                    comment_author: cleanTextForCSV(c.comment_author),  // ← Clean!
                    comment_author_link: `https://www.instagram.com/${c.comment_author}/`,
                    comment_text: cleanTextForCSV(c.comment_text),  // ← Already clean
                    comment_likes: c.comment_likes,
                    comment_timestamp: unixToISO(c.comment_timestamp_unix),
                    comment_timestamp_wib: convertToWIB(unixToISO(c.comment_timestamp_unix)),
                    is_reply: c.parent_comment_pk ? "true" : "false",
                    parent_comment_author: c.parent_comment_pk 
                        ? cleanTextForCSV(allComments.get(c.parent_comment_pk)?.comment_author || "")  // ← Clean!
                        : "",
                    scraped_at: now
                }));
                
                await saveCommentsRealtime(commentsToSave);
            }
            
            // Mark as processed
            if (allPosts.has(post.post_pk)) {
                allPosts.get(post.post_pk)._processed_details = true;
            }
            
            // ========== CLOSE POST ==========
            console.log(`      ❌ Closing...`);
            
            const closeBtn = page.locator('button._abl-, button:has(svg[aria-label="Close"])').first();
            if (await closeBtn.count() > 0) {
                await closeBtn.click({ timeout: 3000 }).catch(() => {});
            } else {
                await page.keyboard.press('Escape');
            }
            
            await page.waitForTimeout(2000);
            
            // Verify closed
            try {
                await page.waitForSelector('article, div[role="dialog"]', { state: 'detached', timeout: 5000 });
            } catch (e) {
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
            }
            
            // ========== BATCH LIMITER ==========
            await batchLimiter.checkAndWait();
            
            const statusEmoji = isUpdate ? '🔄 UPDATED' : '✅ SAVED';
            console.log(`\n   ${statusEmoji} [${i + 1}/${postsToScrape.length}]: ${post.post_code}`);
            console.log(`      📊 Batch: ${batchLimiter.getStatus()}\n`);
            
            await debugPause(page, `Post ${post.post_code} selesai`, 'post');
            
        } catch (e) {
            console.error(`   ❌ GAGAL: ${post.post_code} → ${e.message.substring(0, 100)}`);
        }
        
        // Jeda antar post
        if (i < postsToScrape.length - 1) {
            await page.waitForTimeout(3000);
        }
    }
    
    console.log("\n[TAHAP 2] ✅ Selesai memproses semua detail post");
}

// ========== FUNGSI SCROLL KOMENTAR (v3 - AUTO LOAD MORE) ==========
async function scrollComments(page) {
    console.log("   > 🔄 Mulai auto-load SEMUA komentar...");
    
    try {
        // DETEKSI TIPE POST: Foto vs Reel
        const isPhotoPost = await page.locator('div._aalg').first().count() > 0;
        
        if (isPhotoPost) {
            console.log("      > 📷 Terdeteksi: POST FOTO (panel kanan)");
            await scrollPhotoCommentsUntilEnd(page);
        } else {
            console.log("      > 🎥 Terdeteksi: REEL (fullpage scroll)");
            await scrollReelCommentsUntilEnd(page);
        }
        
        console.log("   > ✅ Selesai load semua komentar");
        
    } catch (e) {
        console.warn(`   > ⚠️  Error saat scroll: ${e.message}`);
    }
}

// --- Helper: Scroll untuk POST FOTO ---
async function scrollPhotoCommentsUntilEnd(page) {
    const commentPanel = page.locator('div._aalg').first();
    
    let iteration = 0;
    let stableCount = 0;
    let lastCommentCount = 0;
    
    while (iteration < 50) { // Max 50 iterasi untuk safety
        iteration++;
        
        // Hitung komentar saat ini
        const currentCommentCount = await page.locator('ul._a9ym > li').count();
        
        console.log(`      > Iterasi #${iteration}: ${currentCommentCount} komentar`);
        
        // Scroll panel ke bawah
        await commentPanel.evaluate(node => {
            node.scrollTop = node.scrollHeight;
        });
        
        // Tunggu API response
        await page.waitForTimeout(2000);
        
        // Cek apakah jumlah komentar bertambah
        if (currentCommentCount === lastCommentCount) {
            stableCount++;
            
            // Jika sudah 2x tidak bertambah, coba cari tombol "Load more"
            if (stableCount >= 2) {
                const loadMoreBtn = await page.locator('button:has-text("more comments"), button:has-text("View more")').count();
                
                if (loadMoreBtn > 0) {
                    console.log(`      > 🖱️  Klik "Load more comments"...`);
                    await page.locator('button:has-text("more comments"), button:has-text("View more")').first().click();
                    await page.waitForTimeout(2000);
                    stableCount = 0; // Reset
                } else {
                    // Tidak ada tombol, tidak ada perubahan = SUDAH SELESAI
                    if (stableCount >= 4) {
                        console.log("      > ✅ Semua komentar sudah dimuat (tidak ada perubahan)");
                        break;
                    }
                }
            }
        } else {
            stableCount = 0;
            lastCommentCount = currentCommentCount;
        }
    }
}

// --- Helper: Scroll untuk REEL ---
async function scrollReelCommentsUntilEnd(page) {
    let iteration = 0;
    let stableCount = 0;
    let lastHeight = 0;
    
    while (iteration < 50) {
        iteration++;
        
        const newHeight = await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
            return document.body.scrollHeight;
        });
        
        console.log(`      > Iterasi #${iteration}: Height ${newHeight}px`);
        
        await page.waitForTimeout(2000);
        
        if (newHeight === lastHeight) {
            stableCount++;
            
            // Coba cari tombol "Load more"
            if (stableCount >= 2) {
                const loadMoreBtn = await page.locator('button:has-text("more comments"), button:has-text("View more")').count();
                
                if (loadMoreBtn > 0) {
                    console.log(`      > 🖱️  Klik "Load more comments"...`);
                    await page.locator('button:has-text("more comments"), button:has-text("View more")').first().click();
                    await page.waitForTimeout(2000);
                    stableCount = 0;
                } else if (stableCount >= 4) {
                    console.log("      > ✅ Sudah di akhir");
                    break;
                }
            }
        } else {
            stableCount = 0;
            lastHeight = newHeight;
        }
    }
}

// ========== EXPAND SEMUA BALASAN (v3 - RECURSIVE) ==========
async function expandAllReplies(page) {
    console.log("   > 🔽 Expand semua balasan komentar...");
    
    try {
        let totalExpanded = 0;
        
        // Ulangi hingga 5 kali untuk ensure semua tombol ter-click
        for (let round = 0; round < 5; round++) {
            // Cari semua tombol "View replies" yang visible
            const replyButtons = await page.locator('button:has-text("View replies"), button:has-text("View reply"), button:has-text("replies")').all();
            
            if (replyButtons.length === 0) {
                if (totalExpanded === 0 && round === 0) {
                    console.log("      > ℹ️  Tidak ada balasan untuk dimuat");
                }
                break;
            }
            
            console.log(`      > Round ${round + 1}: Ditemukan ${replyButtons.length} tombol`);
            
            let clickedInRound = 0;
            for (const button of replyButtons) {
                try {
                    // Scroll button ke viewport dulu
                    await button.scrollIntoViewIfNeeded({ timeout: 1000 });
                    await page.waitForTimeout(200);
                    
                    // Click
                    await button.click({ timeout: 2000 });
                    clickedInRound++;
                    totalExpanded++;
                    
                    // Tunggu API child_comments
                    await page.waitForTimeout(1000);
                } catch (e) {
                    // Button mungkin hilang/berubah, skip
                }
            }
            
            console.log(`      > Round ${round + 1}: Berhasil klik ${clickedInRound} tombol`);
            
            // Jika tidak ada yang di-click di round ini, berarti sudah selesai
            if (clickedInRound === 0) {
                break;
            }
            
            // Tunggu sebentar sebelum round berikutnya
            await page.waitForTimeout(1500);
        }
        
        if (totalExpanded > 0) {
            console.log(`      > ✅ Total expand: ${totalExpanded} balasan`);
        }
        
    } catch (e) {
        console.warn(`   > ⚠️  Error expand: ${e.message}`);
    }
}

// Jalankan fungsi main
main();