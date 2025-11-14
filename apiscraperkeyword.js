// instagram_api_scraper.js (v2 - FIXED Listener Logic + Added Debug Mode)
// Dibuat oleh Gemini, berdasarkan permintaan pengguna
// Metode: Intersepsi Network Request API (GraphQL & v1)
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const fs = require('fs');
const readline = require('readline'); // <-- TAMBAHKAN INI

// ========== ERROR DIAGNOSTIC TOOL (NEW!) ==========
const diagnosticData = {
    session_info: {},
    failed_posts: [],
    network_requests: [],
    screenshots: []
};

// ========== CHECKPOINT SYSTEM (RESUME CAPABILITY!) ==========
const checkpointData = {
    last_update: null,
    current_phase: null,
    current_hashtag: null,
    hashtag_index: 0,
    phase_start_time: null,
    phase_duration_minutes: 0,
    elapsed_minutes: 0,
    remaining_minutes: 0,
    cycle_number: 1,
    posts_collected: 0,
    posts_processed: 0,
    engagement_version: 0  // ← NEW! Track engagement update version (0=discovery, 1=v1, 2=v2, etc.)
};

// ========== CHECKPOINT FUNCTIONS ==========
function saveCheckpoint(phase, hashtag, hashtagIndex, durationMinutes, elapsedMinutes) {
    try {
        checkpointData.last_update = new Date().toISOString();
        checkpointData.current_phase = phase;
        checkpointData.current_hashtag = hashtag;
        checkpointData.hashtag_index = hashtagIndex;
        checkpointData.phase_start_time = new Date().toISOString();
        checkpointData.phase_duration_minutes = durationMinutes;
        checkpointData.elapsed_minutes = elapsedMinutes;
        checkpointData.remaining_minutes = durationMinutes - elapsedMinutes;
        checkpointData.posts_collected = allPosts.size;
        checkpointData.posts_processed = Array.from(allPosts.values()).filter(p => p._processed_details).length;

        const checkpointFile = path.join(CONFIG.output_folder, 'scraper_checkpoint.json');
        fs.writeFileSync(checkpointFile, JSON.stringify(checkpointData, null, 2), 'utf8');

        console.log(`   💾 Checkpoint saved: ${phase} - ${hashtag || 'N/A'} (${elapsedMinutes}/${durationMinutes} min)`);
    } catch (e) {
        console.warn(`   ⚠️  Failed to save checkpoint: ${e.message}`);
    }
}

function loadCheckpoint() {
    try {
        const checkpointFile = path.join(CONFIG.output_folder, 'scraper_checkpoint.json');

        if (fs.existsSync(checkpointFile)) {
            const data = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));

            // Check if checkpoint is recent (< 24 hours old)
            const checkpointAge = Date.now() - new Date(data.last_update).getTime();
            const twentyFourHours = 24 * 60 * 60 * 1000;

            if (checkpointAge < twentyFourHours) {
                Object.assign(checkpointData, data);
                console.log(`\n${"=".repeat(60)}`);
                console.log(`📂 CHECKPOINT FOUND - Resuming from last session`);
                console.log(`${"=".repeat(60)}`);
                console.log(`   Phase: ${data.current_phase}`);
                console.log(`   Hashtag: ${data.current_hashtag || 'N/A'}`);
                console.log(`   Progress: ${data.elapsed_minutes}/${data.phase_duration_minutes} minutes`);
                console.log(`   Remaining: ${data.remaining_minutes} minutes`);
                console.log(`   Posts collected: ${data.posts_collected}`);
                console.log(`   Posts processed: ${data.posts_processed}`);
                console.log(`   Cycle: ${data.cycle_number}`);
                console.log(`${"=".repeat(60)}\n`);
                return true;
            } else {
                console.log(`   ⏰ Checkpoint too old (${Math.round(checkpointAge / 1000 / 60 / 60)}h), starting fresh`);
                clearCheckpoint();
                return false;
            }
        }

        return false;
    } catch (e) {
        console.warn(`   ⚠️  Failed to load checkpoint: ${e.message}`);
        return false;
    }
}

function clearCheckpoint() {
    try {
        const checkpointFile = path.join(CONFIG.output_folder, 'scraper_checkpoint.json');
        if (fs.existsSync(checkpointFile)) {
            fs.unlinkSync(checkpointFile);
            console.log(`   🗑️  Checkpoint cleared`);
        }
    } catch (e) {
        console.warn(`   ⚠️  Failed to clear checkpoint: ${e.message}`);
    }
}

// ========== GRACEFUL SHUTDOWN (CTRL+C HANDLER) ==========
function setupGracefulShutdown(context) {
    let isShuttingDown = false;

    const shutdown = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        console.log(`\n\n${"=".repeat(60)}`);
        console.log(`⚠️  ${signal} RECEIVED - Graceful Shutdown`);
        console.log(`${"=".repeat(60)}`);

        // Save current checkpoint
        if (checkpointData.current_phase) {
            console.log(`   💾 Saving checkpoint before exit...`);
            saveCheckpoint(
                checkpointData.current_phase,
                checkpointData.current_hashtag,
                checkpointData.hashtag_index,
                checkpointData.phase_duration_minutes,
                checkpointData.elapsed_minutes
            );
        }

        // Save diagnostic if any
        if (diagnosticData.failed_posts.length > 0) {
            console.log(`   📊 Saving diagnostic report...`);
            await saveDiagnosticReport();
        }

        console.log(`\n   ✅ Data saved successfully!`);
        console.log(`   💡 Run scraper again to resume from checkpoint\n`);
        console.log(`${"=".repeat(60)}\n`);

        if (context) {
            await context.close().catch(() => {});
        }

        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT (Ctrl+C)'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ========== FOLDER VERSIONING SYSTEM (FOR 1M+ POSTS!) ==========
// Discovery: data/discovery/
// Update 1:  data/engagement_v1/
// Update 2:  data/engagement_v2/ (deletes v1 after success)
// etc.

function getDataFolder() {
    const baseFolder = CONFIG.output_folder;

    // Discovery phase (version 0)
    if (checkpointData.engagement_version === 0) {
        return path.join(baseFolder, 'discovery');
    }

    // Update phase (version 1, 2, 3, ...)
    return path.join(baseFolder, `engagement_v${checkpointData.engagement_version}`);
}

function getPreviousDataFolder() {
    const baseFolder = CONFIG.output_folder;

    // If current is discovery (v0), no previous folder
    if (checkpointData.engagement_version === 0) {
        return null;
    }

    // If current is v1, previous is discovery
    if (checkpointData.engagement_version === 1) {
        return path.join(baseFolder, 'discovery');
    }

    // If current is v2+, previous is v(N-1)
    return path.join(baseFolder, `engagement_v${checkpointData.engagement_version - 1}`);
}

function ensureDataFolderExists() {
    const folder = getDataFolder();
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
        console.log(`   📁 Created data folder: ${folder}`);
    }
    return folder;
}

function cleanupOldEngagementFolder() {
    const previousFolder = getPreviousDataFolder();

    if (!previousFolder) {
        console.log(`   ℹ️  No previous folder to cleanup (Discovery phase)`);
        return;
    }

    if (!fs.existsSync(previousFolder)) {
        console.log(`   ℹ️  Previous folder already cleaned: ${previousFolder}`);
        return;
    }

    try {
        // Safety check: only delete engagement_vN or discovery folders
        const folderName = path.basename(previousFolder);
        if (!folderName.startsWith('engagement_v') && folderName !== 'discovery') {
            console.warn(`   ⚠️  SAFETY: Refusing to delete non-versioned folder: ${previousFolder}`);
            return;
        }

        // Recursive delete
        fs.rmSync(previousFolder, { recursive: true, force: true });
        console.log(`   🗑️  Cleaned up old folder: ${previousFolder}`);
    } catch (e) {
        console.warn(`   ⚠️  Failed to cleanup old folder: ${e.message}`);
    }
}

function determineStartingVersion() {
    const baseFolder = CONFIG.output_folder;

    // Check discovery folder
    const discoveryFolder = path.join(baseFolder, 'discovery');
    const discoveryExists = fs.existsSync(discoveryFolder);

    // Find highest engagement version
    let highestVersion = 0;

    if (fs.existsSync(baseFolder)) {
        const folders = fs.readdirSync(baseFolder);
        for (const folder of folders) {
            const match = folder.match(/^engagement_v(\d+)$/);
            if (match) {
                const version = parseInt(match[1], 10);
                if (version > highestVersion) {
                    highestVersion = version;
                }
            }
        }
    }

    // Logic:
    // - If no discovery and no engagement folders: Start at v0 (discovery)
    // - If discovery exists but no engagement: Start at v1 (first update)
    // - If engagement_vN exists: Start at v(N+1) (next update)

    if (!discoveryExists && highestVersion === 0) {
        console.log(`   📍 Starting fresh: Discovery mode (v0)`);
        return 0;
    }

    if (discoveryExists && highestVersion === 0) {
        console.log(`   📍 Discovery completed, starting: Engagement v1`);
        return 1;
    }

    const nextVersion = highestVersion + 1;
    console.log(`   📍 Continuing from engagement_v${highestVersion}, starting: Engagement v${nextVersion}`);
    return nextVersion;
}


// ========== HELPER: CAPTURE DIAGNOSTIC INFO ==========
async function captureDiagnosticInfo(page, post, errorType, additionalInfo = {}) {
    const timestamp = new Date().toISOString();
    const diagnostic = {
        timestamp: timestamp,
        post_code: post.post_code,
        post_url: post.post_url,
        post_pk: post.post_pk,
        error_type: errorType,
        additional_info: additionalInfo,
        page_url: page.url(),
        page_title: await page.title().catch(() => 'N/A'),
        network_requests: [],
        html_snapshot: '',
        screenshot_path: '',
        console_logs: []
    };
    
    try {
        // ========== 1. CAPTURE VISIBLE TEXT ==========
        const bodyText = await page.locator('body').innerText().catch(() => 'N/A');
        diagnostic.visible_text_sample = bodyText.substring(0, 500);
        
        // ========== 2. CHECK FOR ERROR MESSAGES ==========
        const loginRequired = await page.locator('a[href="/accounts/login/"]').count();
        const postDeleted = await page.locator('text="Sorry, this page isn\'t available"').count();
        const restrictedContent = await page.locator('text="restricted"').count();
        
        diagnostic.error_indicators = {
            login_required: loginRequired > 0,
            post_deleted: postDeleted > 0,
            restricted_content: restrictedContent > 0
        };
        
        // ========== 3. CAPTURE HTML SNAPSHOT ==========
        diagnostic.html_snapshot = await page.content().catch(() => 'N/A');
        
        // ========== 4. TAKE SCREENSHOT ==========
        const screenshotPath = `./debug_${errorType}_${post.post_code}_${Date.now()}.png`;
        await page.screenshot({ 
            path: screenshotPath,
            fullPage: true 
        }).catch(() => {});
        diagnostic.screenshot_path = screenshotPath;
        
        // ========== 5. CAPTURE COOKIES (CHECK SESSION) ==========
        const cookies = await page.context().cookies();
        diagnostic.cookies = {
            count: cookies.length,
            has_sessionid: cookies.some(c => c.name === 'sessionid'),
            has_csrftoken: cookies.some(c => c.name === 'csrftoken'),
            sessionid_sample: cookies.find(c => c.name === 'sessionid')?.value.substring(0, 20) + '...' || 'N/A'
        };
        
        // ========== 6. CAPTURE LOCAL STORAGE ==========
        const localStorage = await page.evaluate(() => {
            return JSON.stringify(window.localStorage);
        }).catch(() => '{}');
        diagnostic.local_storage_keys = Object.keys(JSON.parse(localStorage));
        
    } catch (e) {
        diagnostic.capture_error = e.message;
    }
    
    diagnosticData.failed_posts.push(diagnostic);
    
    console.log(`      📊 Diagnostic captured for ${post.post_code}`);
    
    return diagnostic;
}

// ========== HELPER: SETUP NETWORK MONITOR ==========
function setupNetworkMonitor(page, postCode) {
    const requests = [];
    
    const requestHandler = (request) => {
        const url = request.url();
        
        // Only log Instagram API requests
        if (url.includes('instagram.com')) {
            requests.push({
                timestamp: new Date().toISOString(),
                method: request.method(),
                url: url,
                post_code: postCode,
                resource_type: request.resourceType()
            });
        }
    };
    
    const responseHandler = async (response) => {
        const url = response.url();
        
        // Only log Instagram API requests
        if (url.includes('instagram.com') && 
            (url.includes('/api/') || url.includes('/graphql/') || url.includes('/ajax/'))) {
            
            const request = requests.find(r => r.url === url);
            if (request) {
                request.status = response.status();
                request.status_text = response.statusText();
                
                // Capture response for important endpoints
                if (url.includes('/ajax/navigation/') || 
                    url.includes('/info/') ||
                    url.includes('/comments/')) {
                    try {
                        const contentType = response.headers()['content-type'] || '';
                        if (contentType.includes('application/json')) {
                            const body = await response.text();
                            request.response_body_sample = body.substring(0, 500);
                        }
                    } catch (e) {
                        request.response_error = e.message;
                    }
                }
            }
        }
    };
    
    page.on('request', requestHandler);
    page.on('response', responseHandler);
    
    // Return cleanup function
    return {
        requests: requests,
        cleanup: () => {
            page.off('request', requestHandler);
            page.off('response', responseHandler);
        }
    };
}

// ========== SAVE DIAGNOSTIC REPORT ==========
async function saveDiagnosticReport() {
    const reportPath = path.join(CONFIG.output_folder, `diagnostic_report_${Date.now()}.json`);
    
    try {
        // Add summary
        diagnosticData.summary = {
            total_failed_posts: diagnosticData.failed_posts.length,
            total_network_requests: diagnosticData.network_requests.length,
            timestamp: new Date().toISOString(),
            error_types: {}
        };
        
        // Count error types
        for (const post of diagnosticData.failed_posts) {
            const type = post.error_type;
            diagnosticData.summary.error_types[type] = (diagnosticData.summary.error_types[type] || 0) + 1;
        }
        
        fs.writeFileSync(reportPath, JSON.stringify(diagnosticData, null, 2), 'utf8');
        
        console.log(`\n📊 ============================================`);
        console.log(`📊 DIAGNOSTIC REPORT SAVED`);
        console.log(`📊 ============================================`);
        console.log(`📊 Location: ${reportPath}`);
        console.log(`📊 Failed Posts: ${diagnosticData.failed_posts.length}`);
        console.log(`📊 Network Requests Logged: ${diagnosticData.network_requests.length}`);
        console.log(`📊 Error Types:`);
        for (const [type, count] of Object.entries(diagnosticData.summary.error_types)) {
            console.log(`📊   - ${type}: ${count}`);
        }
        console.log(`📊 ============================================\n`);
        
        return reportPath;
    } catch (e) {
        console.error(`❌ Failed to save diagnostic report: ${e.message}`);
        return null;
    }
}

// ======== KONFIGURASI ========
const CONFIG = {
    // Ganti dengan kredensial Anda
    ig_username: "catharinawijaya36@gmail.com",
    ig_password: "UrLoVeRUrB@Ebook",

    // TAMBAH baris ini (ganti target_usernames):
    target_hashtags: [
        // ========== KEYWORDS UMUM ==========
        "politik",
        "politikindonesia",
        "gerindra",
        "partaigerindra",

        // ========== PRESIDEN & WAPRES ==========
        "prabowo",
        "prabowosubianto",
        "presiden",
        "presidenri",
        "presidenprabowo",
        "gibran",
        "gibranrakabuming",
        "gibranraka",
        "wakilpresiden",
        "wapres",

        // ========== TOKOH GERINDRA ==========
        "sufmidasco",
        "dascoahmad",
        "fadlizon",
        "budimansudjatmiko",
        "rachmatgobel",
        "edhyprabowo",
        "thomasdjiwandono",
        "ahmadmuzani",
        "ariefpoyuono",
        "habiburokhman",
        "rahayusaraswati",

        // ========== KOMBINASI ==========
        "prabowogibran",
        "prabowo2024",
        "gerindramenang"
    ],  // ← TANPA simbol #

    // ========== CONTINUOUS MODE (NON-STOP SCRAPING!) ==========
    CONTINUOUS_MODE: true,              // ← true = jalan terus, false = stop setelah 1 cycle
    CONTINUOUS_COOLDOWN_MINUTES: 60,    // ← Cooldown setelah semua hashtag selesai (default: 60 min)

    // ← Jeda antar hashtag
    hashtag_delay_seconds: 30,
    
    // Folder output
    output_folder: "./instagram_hashtag_data",  // ← NAMA BARU untuk hashtag
    
    // Lokasi data sesi (untuk menyimpan login)
    userDataDir: path.join(os.homedir(), 'playwright_ig_api_session'),
    
    // Batas scroll untuk postingan (misal 10x scroll)
    MAX_PROFILE_SCROLLS: 10,  // ← NAIKKAN untuk first run!
    
    // Batas scroll untuk komentar per postingan (misal 5x scroll)
    MAX_COMMENT_SCROLLS: 3,

    MAX_COMMENTS_PER_POST: 50,

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
function detectScrapingMode(hashtag) {
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
        
        // Cek apakah ada post untuk hashtag ini
        const hashtagPosts = posts.filter(p => p.query_used === hashtag);
        
        if (hashtagPosts.length === 0) {
            console.log(`[MODE] 🆕 FIRST RUN for #${hashtag} (no existing posts)`);
            return 'first_run';
        }
        
        // Cek apakah ada post lebih dari 30 hari
        const oldestPost = hashtagPosts.reduce((oldest, post) => {
            return post.timestamp < oldest.timestamp ? post : oldest;
        });
        
        const daysSinceOldest = (Date.now() / 1000 - oldestPost.timestamp) / 86400;
        
        if (daysSinceOldest < 30) {
            console.log(`[MODE] 🔄 MAINTENANCE MODE for #${hashtag} (oldest post: ${Math.round(daysSinceOldest)} days)`);
            return 'maintenance';
        } else {
            console.log(`[MODE] 🔄 MAINTENANCE MODE for #${hashtag} (${hashtagPosts.length} existing posts)`);
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
// ========== AGGRESSIVE TEXT CLEANING (Remove ALL Special Chars + Unicode Line Terminators!) ==========
function cleanTextForCSV(text) {
    if (!text) return "";
    
    let cleaned = String(text);
    
    // ========== CRITICAL FIX: Remove Unicode Line/Paragraph Separators (LS & PS) ==========
    cleaned = cleaned.replace(/\u2028/g, ' ');  // LINE SEPARATOR (LS) - U+2028
    cleaned = cleaned.replace(/\u2029/g, ' ');  // PARAGRAPH SEPARATOR (PS) - U+2029
    
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
    
    // 6. Remove additional Unicode line breaks (comprehensive)
    cleaned = cleaned.replace(/\u0085/g, ' ');  // Next Line (NEL)
    cleaned = cleaned.replace(/\u000B/g, ' ');  // Vertical Tab
    cleaned = cleaned.replace(/\u000C/g, ' ');  // Form Feed
    
    // 7. Normalize quotes (gunakan straight quotes untuk CSV)
    cleaned = cleaned.replace(/[""]/g, '"');    // Curly double quotes → straight
    cleaned = cleaned.replace(/['']/g, "'");    // Curly single quotes → straight
    cleaned = cleaned.replace(/[«»]/g, '"');    // Guillemets → straight quotes
    
    // 8. Replace multiple spaces with single space
    cleaned = cleaned.replace(/\s{2,}/g, ' ');
    
    // 9. Trim whitespace from start and end
    cleaned = cleaned.trim();
    
    // 10. Escape internal quotes for CSV safety
    cleaned = cleaned.replace(/"/g, '""');  // " → "" (CSV standard escaping)
    
    return cleaned;
}

// ========== GLOBAL FILE NAMES (Semua akun jadi 1 file!) ==========
// ========== VERSIONED FILE PATHS ==========
function getPostsCSVFilename() {
    const folder = ensureDataFolderExists();
    return path.join(folder, 'instagram_posts.csv');
}

function getCommentsCSVFilename() {
    const folder = ensureDataFolderExists();
    return path.join(folder, 'instagram_comments.csv');
}

function getPostsJSONFilename() {
    const folder = ensureDataFolderExists();
    return path.join(folder, 'instagram_posts.json');
}

function getCommentsJSONFilename() {
    const folder = ensureDataFolderExists();
    return path.join(folder, 'instagram_comments.json');
}

function getParentCommentsCSVFilename() {
    const folder = ensureDataFolderExists();
    return path.join(folder, 'instagram_comments_parent.csv');
}

function getParentCommentsJSONFilename() {
    const folder = ensureDataFolderExists();
    return path.join(folder, 'instagram_comments_parent.json');
}

function getChildCommentsCSVFilename() {
    const folder = ensureDataFolderExists();
    return path.join(folder, 'instagram_comments_replies.csv');
}

function getChildCommentsJSONFilename() {
    const folder = ensureDataFolderExists();
    return path.join(folder, 'instagram_comments_replies.json');
}

// ========== READ FROM PREVIOUS VERSION (FOR UPDATES) ==========
function getPreviousPostsJSONFilename() {
    const previousFolder = getPreviousDataFolder();
    if (!previousFolder) return null;

    const jsonFile = path.join(previousFolder, 'instagram_posts.json');
    return fs.existsSync(jsonFile) ? jsonFile : null;
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

// ========== SAVE SINGLE POST (REAL-TIME - WITH VERSIONING!) ==========
async function savePostRealtime(postData) {
    try {
        console.log(`      💾 Saving post to CSV & JSON...`);

        const cleanUrl = postData.post_url.split('?')[0];

        // ========== VERSIONED SAVE LOGIC ==========
        const jsonFile = getPostsJSONFilename();
        const previousJsonFile = getPreviousPostsJSONFilename();

        let isDuplicate = false;
        let isUpdate = false;
        let existingData = [];

        // ========== LOAD DATA FROM CORRECT SOURCE ==========
        // Priority: 1) Current version, 2) Previous version, 3) Empty array

        if (fs.existsSync(jsonFile)) {
            // Load from current version (if exists)
            try {
                const content = fs.readFileSync(jsonFile, 'utf8');
                existingData = JSON.parse(content);
                console.log(`         📖 Loaded ${existingData.length} posts from current version`);
            } catch (e) {
                console.warn(`         ⚠️  Failed to parse current JSON: ${e.message}`);
            }
        } else if (previousJsonFile && fs.existsSync(previousJsonFile)) {
            // Load from previous version (first save in new version)
            try {
                const content = fs.readFileSync(previousJsonFile, 'utf8');
                existingData = JSON.parse(content);
                console.log(`         📖 Loaded ${existingData.length} posts from previous version (v${checkpointData.engagement_version - 1})`);
            } catch (e) {
                console.warn(`         ⚠️  Failed to parse previous JSON: ${e.message}`);
            }
        } else {
            console.log(`         📝 Starting fresh (no previous data)`);
        }

        // ========== CHECK IF POST EXISTS ==========
        const existingPost = existingData.find(p => p.post_url === cleanUrl);

        if (existingPost) {
            if (postData.update_count > 0) {
                isUpdate = true;
                console.log(`         🔄 UPDATE MODE: Will replace existing post`);
            } else {
                isDuplicate = true;
                console.log(`         ⏭️  SKIP: Post already exists`);
            }
        }

        // 2. Jika pure duplicate (bukan update), SKIP SEMUA!
        if (isDuplicate) {
            console.log(`         ⚠️  DUPLICATE DETECTED! Skipping save.`);
            return true; // Return true karena tidak error, hanya skip
        }

        // ========== UPDATE OR ADD POST ==========
        if (isUpdate) {
            // REPLACE existing post
            const index = existingData.findIndex(p => p.post_url === cleanUrl);
            if (index !== -1) {
                existingData[index] = postData;
                console.log(`         ✅ Updated existing post in data array`);
            } else {
                // Fallback: add if not found
                existingData.push(postData);
                console.log(`         ➕ Added as new (fallback)`);
            }
        } else {
            // ADD new post
            existingData.push(postData);
            console.log(`         ➕ Added new post to data array`);
        }

        // ========== SAVE TO CSV (ENTIRE DATASET) ==========
        const csvFile = getPostsCSVFilename();
        const { createObjectCsvWriter } = require('csv-writer');
        const postWriter = createObjectCsvWriter({
            path: csvFile,
            header: [
                {id: 'author', title: 'author'},
                {id: 'author_profile_link', title: 'author_profile_link'},
                {id: 'author_followers', title: 'author_followers'},
                {id: 'location', title: 'location'},
                {id: 'location_short', title: 'location_short'},
                {id: 'location_lat', title: 'location_lat'},
                {id: 'location_lng', title: 'location_lng'},
                {id: 'location_city', title: 'location_city'},
                {id: 'location_address', title: 'location_address'},
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
                {id: 'views', title: 'views'},
                {id: 'query_used', title: 'query_used'},
                {id: 'hashtag_source', title: 'hashtag_source'},
                {id: 'scraped_at', title: 'scraped_at'},
                {id: 'scraped_at_wib', title: 'scraped_at_wib'},
                {id: 'updated_at', title: 'updated_at'},
                {id: 'updated_at_wib', title: 'updated_at_wib'},
                {id: 'update_count', title: 'update_count'}
            ],
            append: false,  // Always rewrite entire dataset
            alwaysQuote: true,
            fieldDelimiter: ',',
            recordDelimiter: '\r\n',
            encoding: 'utf8'
        });

        await postWriter.writeRecords(existingData);
        console.log(`         ✅ CSV saved: ${csvFile} (${existingData.length} posts)`);

        // ========== SAVE TO JSON (ENTIRE DATASET) ==========
        fs.writeFileSync(jsonFile, JSON.stringify(existingData, null, 2), 'utf8');
        console.log(`         ✅ JSON saved: ${jsonFile} (${existingData.length} posts)`);

        return true;
        
    } catch (error) {
        console.error(`         ❌ Save error: ${error.message}`);
        return false;
    }
}

// ========== SAVE COMMENTS (PARENT ONLY - SIMPLIFIED) ==========
async function saveCommentsRealtime(commentsData) {
    if (commentsData.length === 0) return true;
    
    try {
        // ========== FILTER PARENT ONLY ==========
        const parentComments = commentsData.filter(c => c.is_reply === "false");
        
        console.log(`      💾 Saving ${parentComments.length} parent comments (child comments skipped)...`);
        
        if (parentComments.length > 0) {
            await saveParentComments(parentComments);
        } else {
            console.log(`      ⏭️  No parent comments to save`);
        }
        
        return true;
        
    } catch (error) {
        console.error(`         ❌ Save error: ${error.message}`);
        return false;
    }
}

// ========== HELPER: SAVE PARENT COMMENTS ONLY ==========
async function saveParentComments(commentsData) {
    try {
        // ========== SAVE TO CSV (APPEND MODE - MEMORY EFFICIENT!) ==========
        // Note: CSV akan append (bisa ada minor duplicates), tapi JSON tetap clean
        // Tradeoff: Memory efficiency > Perfect CSV (JSON is source of truth)
        const csvFile = getParentCommentsCSVFilename();
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
                {id: 'scraped_at', title: 'scraped_at'}
            ],
            append: fileExists,  // ← APPEND MODE (memory efficient!)
            alwaysQuote: true,
            fieldDelimiter: ',',
            recordDelimiter: '\r\n',
            encoding: 'utf8'
        });

        await commentWriter.writeRecords(commentsData);
        console.log(`         ✅ Parent CSV appended: ${csvFile} (+${commentsData.length} comments)`);
        
        // ========== SAVE TO JSON ==========
        const jsonFile = getParentCommentsJSONFilename();
        let existingData = [];

        if (fs.existsSync(jsonFile)) {
            try {
                const content = fs.readFileSync(jsonFile, 'utf8');
                existingData = JSON.parse(content);
            } catch (e) {}
        }

        // ========== DUPLICATE CHECK (IMPROVED) ==========
        const existingJsonKeys = new Set(
            existingData.map(c => `${c.post_url}:${c.comment_author}:${c.comment_text.substring(0, 50)}`)
        );

        let newJsonCommentsAdded = 0;

        for (const comment of commentsData) {
            const key = `${comment.post_url}:${comment.comment_author}:${comment.comment_text.substring(0, 50)}`;
            if (!existingJsonKeys.has(key)) {
                existingData.push(comment);
                existingJsonKeys.add(key);
                newJsonCommentsAdded++;
            }
        }

        fs.writeFileSync(jsonFile, JSON.stringify(existingData, null, 2), 'utf8');
        console.log(`         ✅ Parent JSON saved: ${jsonFile} (${existingData.length} total, +${newJsonCommentsAdded} new)`);
        
        return true;
        
    } catch (error) {
        console.error(`         ❌ Parent save error: ${error.message}`);
        return false;
    }
}

// ========== CHILD COMMENTS DISABLED ==========
async function saveChildComments(commentsData) {
    console.log(`      ⏭️  SKIP: Child comments disabled (${commentsData.length} child comments ignored)`);
    return true;
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
                const resumeTime = new Date(Date.now() + waitTime);
                const resumeStr = resumeTime.toLocaleTimeString('id-ID', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                });

                console.log(`\n${"=".repeat(60)}`);
                console.log(`⏸️  RATE LIMIT: 200 Posts/Hour Protection`);
                console.log(`${"=".repeat(60)}`);
                console.log(`📊 Processed: ${this.postsProcessed} posts in ${Math.round(elapsed / 1000 / 60)} minutes`);
                console.log(`⏰ Waiting: ${waitMinutes} minutes untuk prevent ban`);
                console.log(`📅 Resume time: ${resumeStr} WIB`);
                console.log(`🛡️  Protection: Instagram rate limit safety`);
                console.log(`${"=".repeat(60)}\n`);

                // Progress indicator during wait
                const intervalMinutes = 5;
                const intervals = Math.floor(waitMinutes / intervalMinutes);

                for (let i = 0; i < intervals; i++) {
                    await new Promise(resolve => setTimeout(resolve, intervalMinutes * 60 * 1000));
                    const remaining = waitMinutes - ((i + 1) * intervalMinutes);
                    if (remaining > 0) {
                        console.log(`   ⏳ ${remaining} minutes remaining until resume...`);
                    }
                }

                // Wait remaining time
                const remainingMs = waitTime - (intervals * intervalMinutes * 60 * 1000);
                if (remainingMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, remainingMs));
                }
            }

            // Reset for next batch
            this.reset();
            console.log(`\n${"=".repeat(60)}`);
            console.log(`✅ RATE LIMIT COOLDOWN SELESAI - Melanjutkan scraping...`);
            console.log(`${"=".repeat(60)}\n`);
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

async function loadExistingData(hashtag) {
    console.log(`[LOAD] Mengecek data lama untuk #${hashtag}...`);
    
    const postFile = getPostsJSONFilename();
    const commentFile = getCommentsJSONFilename();
    
    let loadedPosts = 0;
    let loadedComments = 0;
    
    try {
        // Muat Postingan Lama (filter by hashtag)
        if (fs.existsSync(postFile)) {
            const data = JSON.parse(fs.readFileSync(postFile, 'utf8'));
            for (const post of data) {
                if (post.query_used === hashtag && !allPosts.has(post.post_pk)) {
                    allPosts.set(post.post_pk, post);
                    loadedPosts++;
                }
            }
        }
        
        // Muat Komentar Lama (filter by hashtag)
        if (fs.existsSync(commentFile)) {
            const data = JSON.parse(fs.readFileSync(commentFile, 'utf8'));
            for (const comment of data) {
                if (!allComments.has(comment.comment_pk)) {
                    allComments.set(comment.comment_pk, comment);
                    loadedComments++;
                }
            }
        }
        
        if (loadedPosts > 0 || loadedComments > 0) {
            console.log(`   ✅ RESUME: Berhasil memuat ${loadedPosts} postingan dan ${loadedComments} komentar dari file.`);
            console.log(`   > Postingan baru akan ditambahkan. Postingan lama akan di-skip.`);
        } else {
            console.log(`   > Tidak ada data lama untuk #${hashtag}.`);
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

    // ========== INITIALIZE FOLDER VERSIONING ==========
    console.log(`\n📁 Initializing folder versioning system...`);
    checkpointData.engagement_version = determineStartingVersion();
    console.log(`   Version: ${checkpointData.engagement_version === 0 ? 'Discovery (v0)' : `Engagement v${checkpointData.engagement_version}`}`);
    console.log(`   Data folder: ${getDataFolder()}`);

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

        // ========== SETUP GRACEFUL SHUTDOWN (CTRL+C HANDLER) ==========
        setupGracefulShutdown(context);

        // ========== LOAD CHECKPOINT (RESUME IF EXISTS) ==========
        const hasCheckpoint = loadCheckpoint();

        // ========== CONTINUOUS MODE: INFINITE LOOP! ==========
        let cycleNumber = hasCheckpoint ? checkpointData.cycle_number : 1;
        let continuousMode = CONFIG.CONTINUOUS_MODE;

        while (true) {
            if (cycleNumber > 1) {
                console.log(`\n${"=".repeat(60)}`);
                console.log(`♾️  CONTINUOUS MODE - CYCLE ${cycleNumber}`);
                console.log(`${"=".repeat(60)}`);
            }

            // Ganti loop target_usernames jadi target_hashtags:
            const startIndex = hasCheckpoint ? checkpointData.hashtag_index : 0;

            for (let i = startIndex; i < CONFIG.target_hashtags.length; i++) {
            const hashtag = CONFIG.target_hashtags[i];

            // Skip if checkpoint says to resume from different hashtag
            if (hasCheckpoint && checkpointData.current_hashtag && hashtag !== checkpointData.current_hashtag) {
                console.log(`   ⏭️  Skipping ${hashtag} (resuming from ${checkpointData.current_hashtag})`);
                continue;
            }

            console.log(`\n${"=".repeat(60)}`);
            console.log(`🎯 Memulai Hashtag: #${hashtag} (${i + 1}/${CONFIG.target_hashtags.length})`);
            console.log(`${"=".repeat(60)}`);

            // Save checkpoint at start of hashtag
            saveCheckpoint('discovery', hashtag, i, 60, 0);

            await loadExistingData(hashtag);
            
            // Detect mode
            const mode = detectScrapingMode(hashtag);
            
            if (mode === 'first_run') {
                console.log(`\n┌${"─".repeat(58)}┐`);
                console.log(`│ 🆕 MODE: FIRST RUN (Historical 5-Year Scraping)         │`);
                console.log(`│ Target: All posts from Nov 2020 - Nov 2025              │`);
                console.log(`│ Expected: 500-2000 posts per hashtag                     │`);
                console.log(`└${"─".repeat(58)}┘\n`);
            } else {
                console.log(`\n┌${"─".repeat(58)}┐`);
                console.log(`│ 🔄 MODE: MAINTENANCE (Quick Update)                     │`);
                console.log(`│ Task: Check new posts + update engagement (≤7 days)     │`);
                console.log(`│ Expected: 1-20 new posts per hashtag                     │`);
                console.log(`└${"─".repeat(58)}┘\n`);
            }
            
            // Scraping loop
            let continueScrapingThisHashtag = true;
            let roundNumber = 1;
            
            while (continueScrapingThisHashtag) {
                console.log(`\n${"-".repeat(60)}`);
                
                if (mode === 'first_run') {
                    console.log(`📦 BATCH ${roundNumber} - FIRST RUN untuk #${hashtag}`);
                } else {
                    console.log(`🔄 MAINTENANCE CHECK untuk #${hashtag}`);
                }
                
                console.log(`${"-".repeat(60)}`);
                
                // 1. Scroll hashtag page (UBAH DARI scrapeProfile!)
                const newPostsFound = await scrapeHashtag(page, hashtag, mode);
                
                await debugPause(page, `Batch ${roundNumber} scroll selesai. New posts: ${newPostsFound}`, 'profile');
                
                // 2. Proses detail post (UBAH DARI username!)
                saveCheckpoint('processing', hashtag, i, 120, 0);
                await scrapePostDetails(page, hashtag);

                // Save checkpoint after processing
                saveCheckpoint('processing', hashtag, i, 120, 120);

                // 3. Cek status (UBAH FILTER!)
                const unprocessedPosts = Array.from(allPosts.values()).filter(
                    p => p.query_used === hashtag && !p._processed_details
                );
                
                const totalPosts = Array.from(allPosts.values()).filter(
                    p => p.query_used === hashtag
                ).length;
                
                console.log(`\n📊 STATUS #${hashtag}:`);
                console.log(`   ✅ ${mode === 'first_run' ? 'Batch' : 'Check'} ${roundNumber} selesai`);
                console.log(`   📝 Total posts: ${totalPosts}`);
                console.log(`   📝 Unprocessed: ${unprocessedPosts.length}`);
                console.log(`   📊 Batch limiter: ${batchLimiter.getStatus()}`);
                
                // 4. Decide: Continue atau Stop?
                if (mode === 'maintenance') {
                    console.log(`\n✅ MAINTENANCE COMPLETE untuk #${hashtag}`);
                    continueScrapingThisHashtag = false;
                    
                } else {
                    if (newPostsFound === 0 && unprocessedPosts.length === 0) {
                        console.log(`\n✅ FIRST RUN COMPLETE untuk #${hashtag}!`);
                        console.log(`   📊 Total historical posts (5 years): ${totalPosts}`);
                        continueScrapingThisHashtag = false;
                        
                    } else if (unprocessedPosts.length === 0 && newPostsFound > 0) {
                        console.log(`\n🔄 Batch complete, lanjut batch berikutnya...`);
                        console.log(`   ⏳ Jeda 5 detik untuk keamanan...`);  // ← TAMBAH INI!
                        roundNumber++;
                        await page.waitForTimeout(5000);  // ← DELAY 5 DETIK PENTING!
                        
                    } else {
                        if (roundNumber >= 20) {
                            console.log(`\n⚠️  Reached max 20 batches, stopping.`);
                            console.log(`   💡 Tip: Jika belum sampai cutoff, jalankan lagi (akan resume)`);
                            continueScrapingThisHashtag = false;
                        } else {
                            console.log(`\n🔄 Still ${unprocessedPosts.length} unprocessed, continuing...`);  // ← TAMBAH INI!
                            console.log(`   ⏳ Jeda 5 detik...`);  // ← TAMBAH INI!
                            await page.waitForTimeout(5000);  // ← TAMBAH INI!
                            roundNumber++;
                        }
                    }
                }
            }
            
            // Jeda antar hashtag
            if (i < CONFIG.target_hashtags.length - 1) {
                const delay = mode === 'first_run' ? 60 : CONFIG.hashtag_delay_seconds;
                console.log(`\n⏳ Jeda ${delay} detik sebelum hashtag berikutnya...`);
                await page.waitForTimeout(delay * 1000);
            }
            }

            // ========== END OF CYCLE ==========
            console.log(`\n${"=".repeat(60)}`);
            console.log(`✅ CYCLE ${cycleNumber} SELESAI`);
            console.log(`   Total Postingan unik didata: ${allPosts.size}`);
            console.log(`   Total Komentar unik didata: ${allComments.size}`);
            console.log(`   Data disimpan di folder: ${CONFIG.output_folder}`);
            console.log(`${"=".repeat(60)}`);

            // ========== SAVE DIAGNOSTIC REPORT (IF ANY ERRORS) ==========
            if (diagnosticData.failed_posts.length > 0) {
                await saveDiagnosticReport();
            }

            // ========== CLEAR CHECKPOINT (CYCLE COMPLETE!) ==========
            clearCheckpoint();
            console.log(`   ✅ Cycle ${cycleNumber} checkpoint cleared\n`);

            // ========== CLEANUP OLD FOLDER & INCREMENT VERSION ==========
            console.log(`\n📁 Versioning cleanup...`);
            cleanupOldEngagementFolder();

            // Increment version for next cycle
            checkpointData.engagement_version++;
            console.log(`   📍 Next cycle will use: ${checkpointData.engagement_version === 0 ? 'Discovery' : `Engagement v${checkpointData.engagement_version}`}\n`);

            // ========== CONTINUOUS MODE CHECK ==========
            if (!continuousMode) {
                console.log(`\n🛑 CONTINUOUS MODE DISABLED - Stopping scraper.`);
                break;
            }

            // ========== COOLDOWN PERIOD ==========
            const cooldownMs = CONFIG.CONTINUOUS_COOLDOWN_MINUTES * 60 * 1000;
            const cooldownMinutes = CONFIG.CONTINUOUS_COOLDOWN_MINUTES;
            const nextCycleTime = new Date(Date.now() + cooldownMs);
            const nextCycleStr = nextCycleTime.toLocaleTimeString('id-ID', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });

            console.log(`\n${"=".repeat(60)}`);
            console.log(`♾️  CONTINUOUS MODE: Cooldown Period`);
            console.log(`${"=".repeat(60)}`);
            console.log(`⏰ Waiting ${cooldownMinutes} minutes before next cycle...`);
            console.log(`📅 Next cycle akan dimulai: ${nextCycleStr} WIB`);
            console.log(`💡 Tip: Press Ctrl+C untuk stop scraper`);
            console.log(`${"=".repeat(60)}\n`);

            // Progress indicator during cooldown
            const intervalMinutes = 5;
            const intervals = Math.floor(cooldownMinutes / intervalMinutes);

            for (let j = 0; j < intervals; j++) {
                await page.waitForTimeout(intervalMinutes * 60 * 1000);
                const remaining = cooldownMinutes - ((j + 1) * intervalMinutes);
                console.log(`   ⏳ ${remaining} minutes remaining until next cycle...`);
            }

            // Wait remaining time
            const remainingMs = cooldownMs - (intervals * intervalMinutes * 60 * 1000);
            if (remainingMs > 0) {
                await page.waitForTimeout(remainingMs);
            }

            console.log(`\n🔄 Cooldown selesai! Starting cycle ${cycleNumber + 1}...\n`);
            cycleNumber++;
            checkpointData.cycle_number = cycleNumber;
        }

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

// ========== INTI SCRAPER: PENDENGAR (LISTENER) API (v7 - PARENT COMMENTS ONLY!) ==========
function setupApiListeners(page) {
    console.log("[SETUP] Memasang pendengar API...");
    
    page.on('response', async (response) => {
        const url = response.url();
        
        // ========== SKIP REDIRECT RESPONSES! (CRITICAL FIX!) ==========
        const status = response.status();
        if (status >= 300 && status < 400) {
            // This is a redirect, skip it
            return;
        }
        
        // ========== DEBUG: LOG ALL COMMENT-RELATED REQUESTS ==========
        if (url.includes('/comments') || url.includes('comment')) {
            console.log(`[DEBUG API] 📡 Status ${status}: ${url.substring(0, 120)}...`);
        }
        
        try {
            // ========== API HASHTAG SEARCH ==========
            if (url.includes('/api/v1/fbsearch/web/top_serp/')) {
                const json = await response.json();
                
                const sections = json.media_grid?.sections || [];
                let totalPosts = 0;
                
                for (const section of sections) {
                    const medias = section.layout_content?.medias || [];
                    
                    for (const item of medias) {
                        const post = item.media;
                        if (!post) continue;
                        
                        const post_pk = post.pk;
                        
                        // ========== CUTOFF CHECK ==========
                        if (CONFIG.MAX_POST_AGE_DAYS) {
                            const now = Date.now() / 1000;
                            const postAge = now - post.taken_at;
                            const maxAge = CONFIG.MAX_POST_AGE_DAYS * 86400;
                            
                            if (postAge > maxAge) {
                                continue;
                            }
                        }
                        
                        // ========== AUDIO SOURCE ==========
                        let audioSource = "N/A";
                        if (post.music_metadata?.music_info?.music_asset_info) {
                            const musicAsset = post.music_metadata.music_info.music_asset_info;
                            const title = musicAsset.title || "";
                            const artist = musicAsset.display_artist || "";
                            
                            if (title && artist) {
                                audioSource = `${title} - ${artist}`;
                            } else if (title) {
                                audioSource = title;
                            } else if (artist) {
                                audioSource = artist;
                            }
                        }
                        
                        // ========== ADD POST TO COLLECTION ==========
                        if (!allPosts.has(post_pk)) {
                            allPosts.set(post_pk, {
                                post_pk: post_pk,
                                post_code: post.code,
                                post_url: `https://www.instagram.com/p/${post.code}/`,
                                author_username: post.user?.username || post.owner?.username || "unknown",
                                author_followers: 0,  // ← NEW! Will be updated from /info/ API
                                caption: post.caption?.text || "",
                                timestamp_unix: post.taken_at,
                                like_count: post.like_count || 0,
                                comment_count: post.comment_count || 0,
                                view_count: 0,
                                share_count: "N/A",
                                location: "N/A",
                                audio_source: audioSource,
                                query_used: null,
                                hashtag_source: null,
                                _processed_details: false
                            });

                            totalPosts++;
                        }
                    }
                }
                
                if (totalPosts > 0) {
                    console.log(`[API HASHTAG] ✅ +${totalPosts} posts dari search API`);
                }
            }
            
            // ========== API GRAPHQL ==========
            else if (url.includes('/graphql/query')) {
                const responseText = await response.text();
                
                // ========== HANDLER 1: PROFIL POSTS ==========
                if (responseText.includes('xdt_api__v1__feed__user_timeline_graphql_connection')) {
                    const json = JSON.parse(responseText);
                    const posts = json.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges || [];
                    
                    if (posts.length === 0) return;
                    
                    console.log(`[API PROFIL] ✅ ${posts.length} posts dari profil`);
                    
                    for (const edge of posts) {
                        const post = edge.node;
                        const post_pk = post.pk;
                        
                        // ========== CUTOFF CHECK ==========
                        if (CONFIG.MAX_POST_AGE_DAYS) {
                            const now = Date.now() / 1000;
                            const postAge = now - post.taken_at;
                            const maxAge = CONFIG.MAX_POST_AGE_DAYS * 86400;
                            
                            if (postAge > maxAge) continue;
                        }
                        
                        // ========== AUDIO SOURCE ==========
                        let audioSource = "N/A";
                        
                        if (post.clips_metadata) {
                            const audioType = post.clips_metadata.audio_type;
                            
                            if (audioType === "licensed_music" && post.clips_metadata.music_info) {
                                const musicAsset = post.clips_metadata.music_info.music_asset_info;
                                if (musicAsset) {
                                    const title = musicAsset.title || "";
                                    const artist = musicAsset.display_artist || "";
                                    
                                    if (title && artist) {
                                        audioSource = `${title} - ${artist}`;
                                    } else if (title) {
                                        audioSource = title;
                                    } else if (artist) {
                                        audioSource = artist;
                                    }
                                }
                            } else if (audioType === "original_audio") {
                                audioSource = "N/A";
                            }
                        }
                        
                        // ========== ADD POST TO COLLECTION ==========
                        if (!allPosts.has(post_pk)) {
                            allPosts.set(post_pk, {
                                post_pk: post_pk,
                                post_code: post.code,
                                post_url: `https://www.instagram.com/p/${post.code}/`,
                                author_username: post.user.username,
                                author_followers: 0,  // ← NEW! Will be updated from /info/ API
                                caption: post.caption?.text || "",
                                timestamp_unix: post.taken_at,
                                like_count: post.like_count,
                                comment_count: post.comment_count,
                                view_count: 0,
                                share_count: "N/A",
                                location: post.location?.name || "N/A",
                                audio_source: audioSource,
                                query_used: null,
                                hashtag_source: null,
                                _processed_details: false
                            });
                        }
                    }
                }
                
                // ========== HANDLER 2: GRAPHQL CHILD COMMENTS (DISABLED) ==========
                else if (responseText.includes('xdt_api__v1__media__media_id__comments__parent_comment_id__child_comments__connection')) {
                    console.log(`[API GRAPHQL CHILD] ⏭️  SKIPPED (child comments disabled)`);
                    // Do nothing - skip child comments
                }
            }
            
            // ========== API 2: INFO DETAIL ==========
            else if (url.includes('/api/v1/media/') && url.includes('/info/')) {
                const json = await response.json();
                const post = json.items?.[0];

                if (!post) return;

                const post_pk = post.pk;
                const view_count = post.play_count || 0;

                if (allPosts.has(post_pk)) {
                    const existingPost = allPosts.get(post_pk);
                    existingPost.view_count = view_count;
                    existingPost.like_count = post.like_count || existingPost.like_count;
                    existingPost.comment_count = post.comment_count || existingPost.comment_count;

                    // ========== AUTHOR FOLLOWER COUNT (NEW!) ==========
                    if (post.user?.follower_count !== undefined) {
                        existingPost.author_followers = post.user.follower_count;
                        console.log(`      👥 Author @${post.user.username}: ${post.user.follower_count.toLocaleString()} followers`);
                    }

                    // ========== LOCATION DATA ==========
                    if (post.location) {
                        existingPost.location = post.location.name || "N/A";
                        existingPost.location_short = post.location.short_name || "";
                        existingPost.location_lat = post.location.lat || null;
                        existingPost.location_lng = post.location.lng || null;
                        existingPost.location_city = post.location.city || "";
                        existingPost.location_address = post.location.address || "";
                    }

                    existingPost._processed_details = true;
                }
            }
            
            // ========== API 3: PARENT COMMENTS (REST API - ENABLED) ==========
            else if (url.includes('/api/v1/media/') && url.includes('/comments/') && !url.includes('/child_comments/')) {
                const json = await response.json();
                const comments = json.comments || [];
                
                if (comments.length === 0) return;
                
                const match = url.match(/\/api\/v1\/media\/(.*?)\/comments/);
                if (!match) {
                    console.warn(`[API REST PARENT] ⚠️  Failed to extract media_id from URL`);
                    return;
                }
                
                // ========== LAYER 1: FORCE STRING NORMALIZATION ==========
                let post_pk = String(match[1].split('/')[0]);
                
                // ========== SAFETY: Remove any trailing slashes or query params ==========
                post_pk = post_pk.split('?')[0].split('/')[0].trim();
                
                console.log(`[API REST PARENT] ✅ ${comments.length} parent comments for post_pk: "${post_pk}"`);
                
                // ========== DEBUG: Show first comment for verification ==========
                if (comments.length > 0) {
                    const firstComment = comments[0];
                    console.log(`[API DEBUG] First comment author: ${firstComment.user?.username}, text: "${firstComment.text?.substring(0, 30)}..."`);
                }
                
                // ========== LAYER 4: CHECK IF POST EXISTS IN MEMORY ==========
                const postExists = Array.from(allPosts.values()).some(p => String(p.post_pk) === post_pk);
                
                if (!postExists) {
                    console.warn(`[API DEBUG] ⚠️  Comments captured but post_pk "${post_pk}" not found in allPosts!`);
                    console.warn(`[API DEBUG] 💡 This might be from a different post. Available post_pks: ${Array.from(allPosts.keys()).slice(0, 3).join(', ')}...`);
                }
                
                for (const comment of comments) {
                    const comment_pk = comment.pk;
                    
                    if (!allComments.has(comment_pk)) {
                        allComments.set(comment_pk, {
                            post_pk: post_pk,  // ← Already normalized to String
                            comment_pk: comment_pk,
                            comment_author: comment.user?.username || "unknown",
                            comment_text: comment.text || "",
                            comment_likes: comment.comment_like_count || 0,
                            comment_timestamp_unix: comment.created_at || 0,
                            child_comment_count: comment.child_comment_count || 0,
                            parent_comment_pk: null,
                        });
                    }
                }
            }

            // ========== API 4: CHILD COMMENTS (DISABLED) ==========
            else if (url.includes('/child_comments/')) {
                console.log(`[API REST CHILD] ⏭️  SKIPPED (child comments disabled)`);
                // Do nothing - skip child comments
            }
            
        } catch (e) {
            // Only log errors for comment-related requests
            if (url.includes('/comments') || url.includes('comment')) {
                console.error(`[DEBUG ERROR] Status ${status}, URL: ${url.substring(0, 100)}`);
                console.error(`[DEBUG ERROR] Message: ${e.message}`);
            }
        }
    });
}

// ========== PROSES SCRAPING ==========

// ========== SCRAPE HASHTAG (NEW FUNCTION!) ==========
async function scrapeHashtag(page, hashtag, mode) {
    if (mode === 'maintenance') {
        console.log(`[SCROLL] 🔄 MAINTENANCE MODE: Cek post baru saja...`);
    } else {
        console.log(`[SCROLL] 📥 FIRST RUN: Ambil 5 tahun post history...`);
    }
    
    // Navigate ke halaman explore hashtag
    const hashtagUrl = `https://www.instagram.com/explore/tags/${hashtag}/`;
    console.log(`   > Navigating to: ${hashtagUrl}`);
    
    await page.goto(hashtagUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    
    // Hitung post sebelum scroll
    const postCountBefore = Array.from(allPosts.values()).filter(
        p => p.query_used === hashtag
    ).length;
    
    // ========== MAINTENANCE MODE: MINIMAL SCROLL ==========
    if (mode === 'maintenance') {
        console.log(`   > Maintenance: Scroll minimal (cek ${CONFIG.MAINTENANCE_MODE.MAX_NEW_POSTS_TO_CHECK} post terbaru)`);
        
        // Scroll 2-3 kali saja
        for (let i = 0; i < 3; i++) {
            console.log(`   > Scroll [${i + 1}/3]...`);
            await page.keyboard.press('End');
            await page.waitForTimeout(2000);
        }
        
        // ← FIX: Manual mark posts yang query_used-nya masih null
        let markedPosts = 0;
        for (const [pk, post] of allPosts.entries()) {
            if (post.query_used === null) {
                post.query_used = hashtag;
                post.hashtag_source = hashtag;
                markedPosts++;
            }
        }
        
        if (markedPosts > 0) {
            console.log(`   > 🏷️  Marked ${markedPosts} posts with #${hashtag}`);
        }
        
        const postCountAfter = Array.from(allPosts.values()).filter(
            p => p.query_used === hashtag
        ).length;
        
        const newPostsFound = postCountAfter - postCountBefore;
        console.log(`[SCROLL] ✅ Maintenance: ${newPostsFound} post baru ditemukan`);
        
        return newPostsFound;
    }
    
    // ========== FIRST RUN MODE: SCROLL BERTAHAP (IMPROVED!) ==========
    console.log(`   > First Run: Scroll bertahap (ambil 9-12 post per batch)...`);
    let lastHeight = 0;
    let scrollAttempts = 0;
    let hitCutoff = false;
    let totalScrolls = 0;
    const BATCH_SIZE = 12;              // ← TARGET: 12 posts per batch (CRITICAL!)
    const SCROLL_INCREMENTS = 3;        // ← Berapa kali scroll per batch

    for (let batch = 0; batch < Math.ceil(CONFIG.MAX_PROFILE_SCROLLS / SCROLL_INCREMENTS); batch++) {
        console.log(`\n   📦 BATCH SCROLL ${batch + 1}:`);
        
        // ========== CEK BATCH SIZE SEBELUM SCROLL! (CRITICAL FIX!) ==========
        const currentPostCount = Array.from(allPosts.values()).filter(
            p => p.query_used === hashtag
        ).length;
        
        if (currentPostCount >= BATCH_SIZE) {
            console.log(`      🎯 BATCH SIZE ALREADY REACHED (${currentPostCount}/${BATCH_SIZE})! Stop scrolling.`);
            break;  // ← STOP SEBELUM SCROLL!
        }
        
        // ========== MINI SCROLL (3x) ==========
        for (let miniScroll = 0; miniScroll < SCROLL_INCREMENTS; miniScroll++) {
            totalScrolls++;
            
            if (totalScrolls > CONFIG.MAX_PROFILE_SCROLLS) {
                console.log(`      > Max scroll reached (${CONFIG.MAX_PROFILE_SCROLLS})`);
                break;
            }
            
            await page.keyboard.press('End');
            await page.waitForTimeout(2000);
            
            console.log(`      > Mini-scroll ${miniScroll + 1}/${SCROLL_INCREMENTS}...`);
            
            // ========== CEK LAGI SETELAH SETIAP SCROLL! ==========
            const postCountNow = Array.from(allPosts.values()).filter(
                p => p.query_used === hashtag
            ).length;
            
            if (postCountNow >= BATCH_SIZE) {
                console.log(`      🎯 BATCH SIZE REACHED during scroll (${postCountNow}/${BATCH_SIZE})!`);
                break;  // ← STOP MINI-SCROLL!
            }
        }
        
        // ========== MARK POSTS SETELAH SCROLL ==========
        let markedThisBatch = 0;
        for (const [pk, post] of allPosts.entries()) {
            if (post.query_used === null) {
                post.query_used = hashtag;
                post.hashtag_source = hashtag;
                markedThisBatch++;
            }
        }
        
        // ========== COUNT POSTS ==========
        const hashtagPosts = Array.from(allPosts.values()).filter(
            p => p.query_used === hashtag
        );
        
        console.log(`      ✅ Batch ${batch + 1}: ${hashtagPosts.length} total posts (+${markedThisBatch} new)`);
        
        // ========== CEK CUTOFF ==========
        if (hashtagPosts.length > 0) {
            const oldestPost = hashtagPosts.reduce((oldest, post) => {
                return post.timestamp_unix < oldest.timestamp_unix ? post : oldest;
            });
            
            const postAge = (Date.now() / 1000 - oldestPost.timestamp_unix) / 86400;
            
            if (postAge >= CONFIG.MAX_POST_AGE_DAYS) {
                console.log(`      > ✅ CUTOFF REACHED! Oldest post: ${Math.round(postAge)} days`);
                hitCutoff = true;
                break;
            }
        }
        
        // ========== CEK END OF PAGE ==========
        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        
        if (newHeight === lastHeight) {
            scrollAttempts++;
            if (scrollAttempts >= 2) {
                console.log("      > ✅ Reached end of hashtag results");
                break;
            }
        } else {
            scrollAttempts = 0;
            lastHeight = newHeight;
        }
        
        // ========== JEDA ANTAR BATCH (PENTING!) ==========
        if (batch < 10) {  // Jangan jeda di batch terakhir
            console.log(`      ⏳ Jeda 3 detik sebelum batch berikutnya...`);
            await page.waitForTimeout(3000);
        }
    }
    
    const postCountAfter = Array.from(allPosts.values()).filter(
        p => p.query_used === hashtag
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

// ========== HELPER: WAIT FOR NAVIGATION API (NEW!) ==========
async function waitForNavigationAPI(page, timeout = 10000) {
    return new Promise((resolve) => {
        let received = false;
        
        const handler = (response) => {
            const url = response.url();
            if (url.includes('/ajax/navigation/')) {
                console.log(`      ✅ Navigation API received`);
                received = true;
                page.off('response', handler);
                resolve(true);
            }
        };
        
        page.on('response', handler);
        
        setTimeout(() => {
            page.off('response', handler);
            if (!received) {
                console.log(`      ⚠️  Navigation API timeout`);
            }
            resolve(received);
        }, timeout);
    });
}

// ========== HELPER: WAIT FOR POST INFO API (NEW!) ==========
async function waitForPostInfoAPI(page, postPk, timeout = 15000) {
    return new Promise((resolve) => {
        let received = false;
        
        const handler = async (response) => {
            const url = response.url();
            
            if (url.includes('/api/v1/media/') && url.includes('/info/')) {
                console.log(`      ✅ Post Info API received`);
                received = true;
                
                try {
                    const json = await response.json();
                    const postData = json.items?.[0];
                    
                    if (postData && String(postData.pk) === String(postPk)) {
                        const existingPost = allPosts.get(postPk);
                        if (existingPost) {
                            existingPost.view_count = postData.play_count || 0;
                            existingPost.like_count = postData.like_count || existingPost.like_count;
                            existingPost.comment_count = postData.comment_count || existingPost.comment_count;
                            
                            if (postData.location) {
                                existingPost.location = postData.location.name || "N/A";
                                existingPost.location_short = postData.location.short_name || "";
                                existingPost.location_lat = postData.location.lat || null;
                                existingPost.location_lng = postData.location.lng || null;
                                existingPost.location_city = postData.location.city || "";
                                existingPost.location_address = postData.location.address || "";
                            }
                        }
                    }
                } catch (e) {}
                
                page.off('response', handler);
                resolve(true);
            }
        };
        
        page.on('response', handler);
        
        setTimeout(() => {
            page.off('response', handler);
            if (!received) {
                console.log(`      ⚠️  Post Info API timeout`);
            }
            resolve(received);
        }, timeout);
    });
}

// ========== HELPER: CHECK FOR ERROR PAGES (NEW!) ==========
async function checkForErrorPages(page, postCode) {
    // Check login wall
    const loginWall = await page.locator('a[href="/accounts/login/"]').count();
    if (loginWall > 0) {
        console.log(`      ⚠️  LOGIN WALL! Session expired.`);
        throw new Error("Login required - session expired");
    }

    // Check post deleted/unavailable (IMPROVED - multiple patterns)
    const errorPatterns = [
        'text="Sorry, this page isn\'t available"',
        'text="Post isn\'t available"',
        'text="The link may be broken"'
    ];

    for (const pattern of errorPatterns) {
        const errorPage = await page.locator(pattern).count();
        if (errorPage > 0) {
            console.log(`      ⚠️  Post not available or deleted (detected: "${pattern}")`);
            return 'deleted';
        }
    }

    // Check if post content exists
    const hasContent = await page.locator('article, img[src*="scontent"]').count();
    if (hasContent === 0) {
        console.log(`      ⚠️  Post failed to render`);

        // Take debug screenshot
        try {
            await page.screenshot({
                path: `./debug_failed_${postCode}.png`,
                fullPage: false
            });
            console.log(`      📸 Debug screenshot saved: debug_failed_${postCode}.png`);
        } catch {}

        return 'failed';
    }

    return 'ok';
}

// ========== HELPER: DIRECT POST NAVIGATION (FALLBACK) ==========
async function processPostDirect(page, post, hashtag) {
    console.log(`\n   🎯 [DIRECT] ${post.post_code}`);
    console.log(`      🔗 Navigating to: ${post.post_url}`);
    
    try {
        // ========== LAYER 0: SETUP NETWORK MONITOR (DIAGNOSTIC!) ==========
        const networkMonitor = setupNetworkMonitor(page, post.post_code);
        
        // ========== LAYER 1: SETUP API LISTENERS ==========
        console.log(`      ⏳ Setting up API listeners...`);
        
        const navigationPromise = waitForNavigationAPI(page, 10000);
        const postInfoPromise = waitForPostInfoAPI(page, post.post_pk, 15000);
        
        // ========== LAYER 2: NAVIGATE WITH BETTER WAIT STRATEGY (IMPROVED!) ==========
        const navStart = Date.now();

        await page.goto(post.post_url, {
            waitUntil: 'domcontentloaded',  // Faster than networkidle
            timeout: 30000
        });

        // ========== LAYER 2.5: EARLY UNAVAILABLE POST DETECTION (NEW! SAVES 27 SECONDS!) ==========
        console.log(`      🔍 Quick check for unavailable posts...`);
        await page.waitForTimeout(2000);  // Wait 2s for DOM to render

        const earlyCheck = await checkForErrorPages(page, post.post_code);

        if (earlyCheck === 'deleted') {
            console.log(`      ⚡ EARLY SKIP: Post unavailable (saved ~27 seconds)`);
            await captureDiagnosticInfo(page, post, 'post_unavailable_early', {
                reason: 'Post not available - detected early (2s)',
                time_saved: '~27 seconds'
            });
            diagnosticData.network_requests.push(...networkMonitor.requests);
            networkMonitor.cleanup();
            post._processed_details = true;
            return false;
        }

        // ========== LAYER 3: WAIT FOR CRITICAL APIs (IF POST EXISTS) ==========
        console.log(`      ⏳ Post exists, waiting for APIs...`);
        await navigationPromise;  // Wait for route config
        await postInfoPromise;    // Wait for post data

        const apiTime = ((Date.now() - navStart) / 1000).toFixed(1);
        console.log(`      ✅ APIs received in ${apiTime}s`);

        // ========== LAYER 4: GIVE DOM TIME TO RENDER (INCREASED!) ==========
        await page.waitForTimeout(5000);  // Increased from 4s to 5s

        // ========== LAYER 5: COMPREHENSIVE ERROR CHECKING (FINAL CHECK) ==========
        const errorStatus = await checkForErrorPages(page, post.post_code);

        if (errorStatus === 'deleted') {
            await captureDiagnosticInfo(page, post, 'post_deleted', {
                reason: 'Post not available or deleted'
            });
            diagnosticData.network_requests.push(...networkMonitor.requests);
            networkMonitor.cleanup();
            post._processed_details = true;
            return false;
        }

        if (errorStatus === 'failed') {
            await captureDiagnosticInfo(page, post, 'api_timeout', {
                navigation_api: 'timeout',
                post_info_api: 'timeout',
                network_requests: networkMonitor.requests
            });
            diagnosticData.network_requests.push(...networkMonitor.requests);
            networkMonitor.cleanup();
            return false;
        }
        
        // ========== EXTRACT DATA (COPY DARI scrapePostDetails) ==========
        const postContainer = page.locator('article').first();
        
        console.log(`      📝 EXTRACTING DATA...`);
        
        // 1. Check if update needed
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
                post._processed_details = true;
                return true;
            }
        }
        
        // 2. Extract engagement
        const author = post.author_username;
        const authorProfileLink = `https://www.instagram.com/${author}/`;
        
        const currentPost = allPosts.get(post.post_pk);
        const likes = currentPost.like_count || 0;
        const comments = currentPost.comment_count || 0;
        const views = currentPost.view_count || 0;
        
        console.log(`         Author: ${author}`);
        console.log(`         Likes: ${likes} | Comments: ${comments} | Views: ${views}`);
        
        // 3. Location
        let location = "N/A";
        let locationShort = "";
        let locationLat = null;
        let locationLng = null;
        let locationCity = "";
        let locationAddress = "";
        
        if (currentPost?.location && currentPost.location !== "N/A") {
            location = cleanTextForCSV(currentPost.location);
            locationShort = currentPost.location_short || "";
            locationLat = currentPost.location_lat;
            locationLng = currentPost.location_lng;
            locationCity = currentPost.location_city || "";
            locationAddress = currentPost.location_address || "";
        }
        
        // 4. Audio (video only)
        let audioSource = "N/A";
        const isVideo = post.post_url.includes('/reel/') || currentPost?.view_count > 0;
        
        if (isVideo && currentPost?.audio_source && currentPost.audio_source !== "N/A") {
            audioSource = cleanTextForCSV(currentPost.audio_source);
        }
        
        // 5. Caption & media
        let contentText = post.caption || existingPost?.content_text || "";
        let imageUrl = existingPost?.image_url || "N/A";
        let videoUrl = existingPost?.video_url || "N/A";
        let imageSource = existingPost?.image_source || "N/A";
        
        if (isVideo) {
            videoUrl = post.post_url;
        } else {
            imageUrl = post.post_url;
            if (!isUpdate || imageSource === "N/A") {
                try {
                    const img = postContainer.locator('img[src*="scontent"]').first();
                    if (await img.count() > 0) {
                        imageSource = await img.getAttribute('src');
                    }
                } catch (e) {}
            }
        }
        
        // 6. Timestamps
        const timestampISO = unixToISO(post.timestamp_unix);
        const timestampWIB = convertToWIB(timestampISO);
        
        // 7. Extract comments (simplified - same logic)
        let extractedComments = [];
        let shouldExtractComments = true;
        
        if (comments === 0) {
            shouldExtractComments = false;
        } else if (comments === 1) {
            await page.waitForTimeout(3000);
            const capturedComments = Array.from(allComments.values())
                .filter(c => String(c.post_pk) === String(post.post_pk));
            extractedComments = capturedComments;
            shouldExtractComments = false;
        } else if (isUpdate && existingPost.comments === comments) {
            shouldExtractComments = false;
        }
        
        if (shouldExtractComments && comments > 1) {
            console.log(`      💬 Extracting comments (target: ${Math.min(comments, CONFIG.MAX_COMMENTS_PER_POST)})...`);
            
            let currentPostPk = String(post.post_pk);
            await scrollComments(page, currentPostPk);
            await page.waitForTimeout(2000);
            
            extractedComments = Array.from(allComments.values())
                .filter(c => String(c.post_pk) === String(post.post_pk))
                .slice(0, CONFIG.MAX_COMMENTS_PER_POST);
            
            console.log(`         ✅ Scraped: ${extractedComments.length} comments`);
        }
        
        // 8. Save post
        const now = new Date().toISOString();
        
        const postData = {
            author: cleanTextForCSV(author),
            author_profile_link: authorProfileLink,
            author_followers: currentPost?.author_followers || 0,
            location: cleanTextForCSV(location),
            location_short: cleanTextForCSV(locationShort),
            location_lat: locationLat,
            location_lng: locationLng,
            location_city: cleanTextForCSV(locationCity),
            location_address: cleanTextForCSV(locationAddress),
            audio_source: cleanTextForCSV(audioSource),
            timestamp: post.timestamp_unix,
            timestamp_iso: timestampISO,
            timestamp_wib: timestampWIB,
            post_url: post.post_url,
            content_text: cleanTextForCSV(contentText),
            image_url: imageUrl,
            video_url: videoUrl,
            image_source: imageSource,
            video_source: "N/A",
            likes: likes,
            comments: comments,
            views: views,
            query_used: cleanTextForCSV(hashtag),
            hashtag_source: cleanTextForCSV(hashtag),
            scraped_at: isUpdate ? existingPost.scraped_at : now,
            scraped_at_wib: isUpdate ? existingPost.scraped_at_wib : convertToWIB(now),
            updated_at: now,
            updated_at_wib: convertToWIB(now),
            update_count: isUpdate ? (existingPost.update_count || 0) + 1 : 0,
            _previous_engagement: isUpdate ? (existingPost.likes + (existingPost.comments * 5) + (existingPost.views * 0.1)) : 0
        };
        
        await savePostRealtime(postData);
        
        // 9. Save comments
        if (extractedComments.length > 0) {
            const commentsToSave = extractedComments.map(c => ({
                post_url: post.post_url,
                post_author: cleanTextForCSV(author),
                comment_author: cleanTextForCSV(c.comment_author),
                comment_author_link: `https://www.instagram.com/${c.comment_author}/`,
                comment_text: cleanTextForCSV(c.comment_text),
                comment_likes: c.comment_likes,
                comment_timestamp: unixToISO(c.comment_timestamp_unix),
                comment_timestamp_wib: convertToWIB(unixToISO(c.comment_timestamp_unix)),
                is_reply: c.parent_comment_pk ? "true" : "false",
                parent_comment_author: c.parent_comment_pk 
                    ? cleanTextForCSV(allComments.get(c.parent_comment_pk)?.comment_author || "")
                    : "",
                scraped_at: now
            }));
            
            await saveCommentsRealtime(commentsToSave);
        }
        
        post._processed_details = true;

        // ========== CLEANUP MONITOR (SUCCESS!) ==========
        diagnosticData.network_requests.push(...networkMonitor.requests);
        networkMonitor.cleanup();

        await batchLimiter.checkAndWait();

        const statusEmoji = isUpdate ? '🔄 UPDATED' : '✅ SAVED';
        console.log(`\n   ${statusEmoji} [DIRECT]: ${post.post_code}\n`);

        return true;
        
    } catch (error) {
        console.error(`      ❌ Error: ${error.message.substring(0, 80)}`);
        return false;
    }
}

// ========== PROSES DETAIL POST: SMART UPDATE + SKIP ZERO COMMENTS ==========
async function scrapePostDetails(page, hashtag) {
    console.log(`[TAHAP 2] 📥 Mengambil detail & komentar untuk #${hashtag}...`);
    
    const postsToScrape = Array.from(allPosts.values()).filter(
        p => (p.query_used === hashtag || p.query_used === null) && !p._processed_details
    );
    
    if (postsToScrape.length === 0) {
        console.log("[TAHAP 2] ✅ Semua postingan sudah diproses.");
        return;
    }
    
    console.log(`   > 🎯 Akan memproses ${postsToScrape.length} postingan...`);
    console.log(`   > 📊 Batch status: ${batchLimiter.getStatus()}\n`);
    
    // ========== SCROLL BALIK KE ATAS ==========
    console.log(`   ⬆️  Scroll balik ke atas...`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);
    
    // ========== PROCESS POSTS IN DOM ORDER (TOP → BOTTOM) ==========
    let processedCount = 0;
    let scrollAttempts = 0;
    const MAX_SCROLL_ATTEMPTS = 50;  // Max scroll cycles
    
    while (processedCount < postsToScrape.length && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
        scrollAttempts++;
        
        console.log(`\n   🔍 [Scroll Cycle ${scrollAttempts}] Looking for posts...`);
        
        // ========== GET ALL VISIBLE POST LINKS IN CURRENT VIEWPORT ==========
        const visibleLinks = await page.locator('a[href*="/p/"]').all();
        
        console.log(`      Found ${visibleLinks.length} links in viewport`);
        
        let foundInThisCycle = 0;
        
        // ========== PROCESS EACH VISIBLE LINK ==========
        for (const link of visibleLinks) {
            try {
                const href = await link.getAttribute('href');
                if (!href) continue;
                
                // Extract post code from href
                const codeMatch = href.match(/\/p\/([^\/]+)/);
                if (!codeMatch) continue;
                
                const postCode = codeMatch[1];
                
                // Find matching post in our collection
                const post = postsToScrape.find(p => p.post_code === postCode);
                if (!post) continue;  // Not in our target list
                
                // Skip if already processed
                if (post._processed_details) continue;
                
                // ========== FOUND TARGET POST! ==========
                console.log(`\n   📍 [${processedCount + 1}/${postsToScrape.length}] ${post.post_code}`);
                
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
                        post._processed_details = true;
                        processedCount++;
                        continue;
                    }
                }
                
                // ========== SCROLL POST INTO VIEW ==========
                await link.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(500);
                
                // ========== HIGHLIGHT POST ==========
                await link.evaluate(el => {
                    el.style.outline = '5px solid #FFD700';
                    el.style.boxShadow = '0 0 20px rgba(255,215,0,0.8)';
                }).catch(() => {});
                await page.waitForTimeout(300);
                
                // ========== CLICK POST ==========
                console.log(`      🖱️  Klik post...`);
                try {
                    await link.click({ timeout: 5000 });
                } catch {
                    await link.click({ force: true, timeout: 5000 });
                }
                
                await page.waitForTimeout(4000);
                
                // ========== VERIFY MODAL OPENED ==========
                try {
                    await page.waitForSelector('article, div[role="dialog"]', { timeout: 10000 });
                    console.log(`      ✅ Modal opened!`);
                } catch (e) {
                    console.log(`      ❌ Modal failed to open, skip`);
                    continue;
                }

                // ========== CRITICAL FIX: GET ACTUAL POST_PK FROM MODAL URL! ==========
                await page.waitForTimeout(2000);  // Wait for URL update

                const currentUrl = page.url();
                const urlPostCode = currentUrl.match(/\/p\/([^\/\?]+)/)?.[1];

                console.log(`      🔍 URL Verification:`);
                console.log(`         - Expected post: ${post.post_code} (pk: ${post.post_pk})`);
                console.log(`         - Modal URL post: ${urlPostCode || 'N/A'}`);

                // ========== MISMATCH DETECTION ==========
                if (urlPostCode && urlPostCode !== post.post_code) {
                    console.log(`      ⚠️  WARNING: URL mismatch detected!`);
                    console.log(`      💡 Clicked: ${post.post_code}, but opened: ${urlPostCode}`);
                    console.log(`      🔄 Trying to close and retry...`);
                    
                    // Close modal
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(1000);
                    
                    // Try to find correct link
                    const correctLink = page.locator(`a[href*="/p/${post.post_code}"]`).first();
                    if (await correctLink.count() > 0) {
                        console.log(`      🔄 Retrying with correct link...`);
                        await correctLink.scrollIntoViewIfNeeded();
                        await page.waitForTimeout(500);
                        await correctLink.click({ timeout: 5000 });
                        await page.waitForTimeout(3000);
                        
                        // Re-verify
                        const retryUrl = page.url();
                        const retryCode = retryUrl.match(/\/p\/([^\/\?]+)/)?.[1];
                        
                        if (retryCode !== post.post_code) {
                            console.log(`      ❌ Still mismatch after retry, skipping this post`);
                            continue;
                        }
                        console.log(`      ✅ Retry successful!`);
                    } else {
                        console.log(`      ❌ Correct link not found, skipping`);
                        continue;
                    }
                }

                // ========== GET REAL post_pk FROM API (via allPosts lookup) ==========
                let actualPostPk = post.post_pk;

                // Try to find the ACTUAL post_pk from allPosts using the modal URL code
                if (urlPostCode) {
                    const actualPost = Array.from(allPosts.values()).find(p => p.post_code === urlPostCode);
                    if (actualPost) {
                        actualPostPk = actualPost.post_pk;
                        console.log(`      ✅ Found actual post_pk from API: ${actualPostPk}`);
                    } else {
                        console.log(`      ⚠️  Warning: Post not found in allPosts, using original pk`);
                    }
                }

                // ========== EXTRACT DATA ==========
                const postContainer = page.locator('article, div[role="dialog"]').first();

                console.log(`\n      📝 EXTRACTING DATA...`);
                
                // 1. Author
                const author = post.author_username;
                const authorProfileLink = `https://www.instagram.com/${author}/`;
                console.log(`         👤 Author: ${author}`);
                
                // 2. Location
                const currentPost = allPosts.get(post.post_pk);
                let location = "N/A";
                let locationShort = "";
                let locationLat = null;
                let locationLng = null;
                let locationCity = "";
                let locationAddress = "";
                
                if (currentPost?.location && currentPost.location !== "N/A") {
                    location = cleanTextForCSV(currentPost.location);
                    locationShort = currentPost.location_short || "";
                    locationLat = currentPost.location_lat;
                    locationLng = currentPost.location_lng;
                    locationCity = currentPost.location_city || "";
                    locationAddress = currentPost.location_address || "";
                    console.log(`         ✅ Location: ${location}`);
                } else if (existingPost?.location && existingPost.location !== "N/A") {
                    location = existingPost.location;
                    locationShort = existingPost.location_short || "";
                    locationLat = existingPost.location_lat;
                    locationLng = existingPost.location_lng;
                    locationCity = existingPost.location_city || "";
                    locationAddress = existingPost.location_address || "";
                    console.log(`         ✅ Location from cache: ${location}`);
                } else {
                    console.log(`         ℹ️  No location`);
                }
                
                // 3. Audio Source (WITH VALIDATION!)
                let audioSource = "N/A";

                // ========== CEK MEDIA TYPE DULU! ==========
                const isVideo = post.post_url.includes('/reel/') || 
                                post.post_url.includes('video') ||
                                currentPost?.view_count > 0;  // ← Video pasti punya view count!

                if (isVideo) {
                    // Only check audio for videos/reels
                    if (currentPost?.audio_source && currentPost.audio_source !== "N/A") {
                        audioSource = cleanTextForCSV(currentPost.audio_source);
                        console.log(`         🎵 Audio: ${audioSource.substring(0, 50)}${audioSource.length > 50 ? '...' : ''}`);
                    } else if (existingPost?.audio_source && existingPost.audio_source !== "N/A") {
                        audioSource = existingPost.audio_source;
                        console.log(`         🎵 Audio from cache`);
                    } else {
                        console.log(`         ℹ️  No audio (video with no music)`);
                    }
                } else {
                    // FOTO = NO AUDIO!
                    audioSource = "N/A";
                    console.log(`         📷 Photo post (no audio)`);
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
                    if (!isUpdate || imageSource === "N/A") {
                        try {
                            const img = postContainer.locator('img[src*="scontent"]').first();
                            if (await img.count() > 0) {
                                imageSource = await img.getAttribute('src');
                            }
                        } catch (e) {}
                    }
                }
                
                // 7. Engagement
                const likes = currentPost.like_count || 0;
                const comments = currentPost.comment_count || 0;
                const views = currentPost.view_count || 0;
                
                console.log(`         Likes: ${likes} | Comments: ${comments} | Views: ${views}`);
                
                if (isUpdate) {
                    const oldLikes = existingPost.likes || 0;
                    const oldComments = existingPost.comments || 0;
                    const oldViews = existingPost.views || 0;
                    console.log(`         📈 Change: L+${likes - oldLikes} | C+${comments - oldComments} | V+${views - oldViews}`);
                }
                
                // ========== EXTRACT COMMENTS (IMPROVED - HANDLE 0 & 1 COMMENT) ==========
                let extractedComments = [];
                let shouldExtractComments = true;

                // ========== FIX 1: HANDLE 0 COMMENTS ==========
                if (comments === 0) {
                    console.log(`\n      ⏭️  SKIP COMMENTS: Post has 0 comments`);
                    shouldExtractComments = false;
                }

                // ========== FIX 2: HANDLE 1 COMMENT (SPECIAL CASE) ==========
                else if (comments === 1) {
                    console.log(`\n      💬 Post has exactly 1 comment...`);
                    
                    // Tunggu sebentar untuk API menangkap comment
                    await page.waitForTimeout(3000);
                    
                    // Cek apakah comment sudah tertangkap API
                    const capturedComments = Array.from(allComments.values())
                        .filter(c => c.post_pk === post.post_pk);
                    
                    if (capturedComments.length > 0) {
                        console.log(`      ✅ Comment already captured by API (${capturedComments.length})`);
                        extractedComments = capturedComments;
                        shouldExtractComments = false; // Skip scroll karena sudah dapat
                    } else {
                        console.log(`      🔄 Comment not yet captured, trying light scroll...`);
                        // Light scroll untuk trigger API
                        try {
                            const isPhotoPost = await page.locator('div._aalg').first().count() > 0;
                            if (isPhotoPost) {
                                const commentPanel = page.locator('div._aalg').first();
                                await commentPanel.evaluate(node => {
                                    node.scrollTop = node.scrollHeight;
                                });
                            } else {
                                await page.evaluate(() => window.scrollBy(0, 300));
                            }
                            await page.waitForTimeout(2000);
                        } catch (e) {}
                        
                        // Cek lagi setelah scroll
                        const capturedAfterScroll = Array.from(allComments.values())
                            .filter(c => c.post_pk === post.post_pk);
                        
                        if (capturedAfterScroll.length > 0) {
                            console.log(`      ✅ Comment captured after light scroll`);
                            extractedComments = capturedAfterScroll;
                        } else {
                            console.log(`      ⚠️  Comment still not captured, continuing...`);
                        }
                        shouldExtractComments = false; // Jangan scroll penuh
                    }
                }

                // ========== FIX 3: HANDLE UPDATE MODE (NO NEW COMMENTS) ==========
                else if (isUpdate && existingPost.comments === comments) {
                    console.log(`\n      ⏭️  SKIP COMMENTS: No new comments since last update`);
                    shouldExtractComments = false;
                }

                // ========== NORMAL EXTRACTION (2+ COMMENTS) ==========
                if (shouldExtractComments && comments > 1) {
                    console.log(`\n      💬 Extracting comments (target: ${Math.min(comments, CONFIG.MAX_COMMENTS_PER_POST)})...`);
                    
                    // ========== LAYER 1: USE ACTUAL POST_PK FROM MODAL ==========
                    let currentPostPk = String(actualPostPk);  // ← CHANGED: use actualPostPk instead of post.post_pk
                    
                    console.log(`      🔍 DEBUG: Searching for comments with post_pk = "${currentPostPk}" (type: ${typeof currentPostPk})`);
                    
                    // ========== LAYER 2: PRE-CHECK - Are comments already captured? ==========
                    const alreadyCaptured = Array.from(allComments.values())
                        .filter(c => String(c.post_pk) === currentPostPk).length;
                    
                    if (alreadyCaptured > 0) {
                        console.log(`      ✅ EARLY WIN: ${alreadyCaptured} comments already captured by API before scroll!`);
                        extractedComments = Array.from(allComments.values())
                            .filter(c => String(c.post_pk) === currentPostPk)
                            .slice(0, CONFIG.MAX_COMMENTS_PER_POST);
                        
                        // Still scroll if target not reached
                        if (alreadyCaptured < CONFIG.MAX_COMMENTS_PER_POST) {
                            console.log(`      🔄 But target is ${CONFIG.MAX_COMMENTS_PER_POST}, continuing scroll...`);
                            await scrollComments(page, currentPostPk);
                        } else {
                            console.log(`      ⏭️  Target already reached, skip scroll`);
                            shouldExtractComments = false;  // Skip scroll
                        }
                    } else {
                        console.log(`      🔄 No pre-captured comments, starting scroll...`);
                        await scrollComments(page, currentPostPk);
                    }
                    await page.waitForTimeout(2000);
                    
                    extractedComments = Array.from(allComments.values())
                        .filter(c => c.post_pk === post.post_pk)
                        .slice(0, CONFIG.MAX_COMMENTS_PER_POST);
                    
                    console.log(`         ✅ Scraped: ${extractedComments.length} comments`);
                }

                // ========== FINAL VALIDATION ==========
                if (extractedComments.length === 0 && comments > 0) {
                    console.log(`      ⚠️  WARNING: API reported ${comments} comments but captured 0`);
                    console.log(`      💡 TIP: Comments may be private or restricted`);
                }
                
                // ========== SAVE POST ==========
                const now = new Date().toISOString();
                
                const postData = {
                    author: cleanTextForCSV(author),
                    author_profile_link: authorProfileLink,
                    location: cleanTextForCSV(location),
                    location_short: cleanTextForCSV(locationShort),
                    location_lat: locationLat,
                    location_lng: locationLng,
                    location_city: cleanTextForCSV(locationCity),
                    location_address: cleanTextForCSV(locationAddress),
                    audio_source: cleanTextForCSV(audioSource),
                    timestamp: post.timestamp_unix,
                    timestamp_iso: timestampISO,
                    timestamp_wib: timestampWIB,
                    post_url: urlPostCode ? `https://www.instagram.com/p/${urlPostCode}/` : post.post_url,  // ← Use actual URL!
                    content_text: cleanTextForCSV(contentText),
                    image_url: imageUrl,
                    video_url: videoUrl,
                    image_source: imageSource,
                    video_source: "N/A",
                    likes: likes,
                    comments: comments,
                    views: views,
                    query_used: cleanTextForCSV(hashtag),
                    hashtag_source: cleanTextForCSV(hashtag),
                    scraped_at: isUpdate ? existingPost.scraped_at : now,
                    scraped_at_wib: isUpdate ? existingPost.scraped_at_wib : convertToWIB(now),
                    updated_at: now,
                    updated_at_wib: convertToWIB(now),
                    update_count: isUpdate ? (existingPost.update_count || 0) + 1 : 0,
                    _previous_engagement: isUpdate ? (existingPost.likes + (existingPost.comments * 5) + (existingPost.views * 0.1)) : 0
                };
                
                await savePostRealtime(postData);
                
                // ========== SAVE COMMENTS ==========
                if (extractedComments.length > 0) {
                    const commentsToSave = extractedComments.map(c => ({
                        post_url: post.post_url,
                        post_author: cleanTextForCSV(author),
                        comment_author: cleanTextForCSV(c.comment_author),
                        comment_author_link: `https://www.instagram.com/${c.comment_author}/`,
                        comment_text: cleanTextForCSV(c.comment_text),
                        comment_likes: c.comment_likes,
                        comment_timestamp: unixToISO(c.comment_timestamp_unix),
                        comment_timestamp_wib: convertToWIB(unixToISO(c.comment_timestamp_unix)),
                        is_reply: c.parent_comment_pk ? "true" : "false",
                        parent_comment_author: c.parent_comment_pk 
                            ? cleanTextForCSV(allComments.get(c.parent_comment_pk)?.comment_author || "")
                            : "",
                        scraped_at: now
                    }));
                    
                    await saveCommentsRealtime(commentsToSave);
                }
                
                // Mark as processed
                post._processed_details = true;
                processedCount++;
                foundInThisCycle++;
                
                // ========== CLOSE MODAL ==========
                console.log(`      ❌ Closing modal...`);
                
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
                console.log(`\n   ${statusEmoji} [${processedCount}/${postsToScrape.length}]: ${post.post_code}`);
                console.log(`      📊 Batch: ${batchLimiter.getStatus()}\n`);
                
                await debugPause(page, `Post ${post.post_code} selesai`, 'post');
                
            } catch (e) {
                console.error(`      ❌ Error: ${e.message.substring(0, 80)}`);
            }
        }
        
        console.log(`      ✅ Processed ${foundInThisCycle} posts in this cycle`);
        
        // ========== SCROLL DOWN FOR NEXT BATCH ==========
        if (processedCount < postsToScrape.length) {
            console.log(`      ⬇️  Scrolling down for next batch...`);
            await page.keyboard.press('PageDown');
            await page.waitForTimeout(2000);
        }
        
        // ========== DETECT STUCK: 5+ Cycles Without Progress ==========
        if (foundInThisCycle === 0) {
            scrollAttempts++;
        } else {
            scrollAttempts = 0;  // Reset if found something
        }
        
        // ========== SWITCH TO DIRECT NAVIGATION IF STUCK ==========
        if (scrollAttempts >= 5 && processedCount < postsToScrape.length) {
            console.log(`\n   ⚠️  STUCK DETECTED: ${scrollAttempts} cycles without progress`);
            console.log(`   🔄 SWITCHING TO DIRECT NAVIGATION for remaining ${postsToScrape.length - processedCount} posts...\n`);
            
            // Get unprocessed posts
            const unprocessedPosts = postsToScrape.filter(p => !p._processed_details);
            
            console.log(`   📋 Processing ${unprocessedPosts.length} posts directly...`);
            
            for (const unprocessedPost of unprocessedPosts) {
                const success = await processPostDirect(page, unprocessedPost, hashtag);
                
                if (success) {
                    processedCount++;
                    console.log(`   📊 Progress: ${processedCount}/${postsToScrape.length}`);
                }
                
                // Small delay between direct navigations
                await page.waitForTimeout(3000);
            }
            
            break;  // Exit scroll loop
        }
    }
    
    console.log(`\n[TAHAP 2] ✅ Selesai! Processed ${processedCount}/${postsToScrape.length} posts`);
    
    // ========== FINAL CHECK ==========
    if (processedCount < postsToScrape.length) {
        const stillUnprocessed = postsToScrape.filter(p => !p._processed_details).length;
        console.log(`   ⚠️  WARNING: ${stillUnprocessed} posts still unprocessed after all attempts`);
    } else {
        console.log(`   🎉 SUCCESS: All posts processed!`);
    }
}

// ========== HUMAN-LIKE BEHAVIOR HELPERS ==========
async function humanDelay(min = 800, max = 2000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
}

async function humanScroll(page, distance = null) {
    // Random scroll distance if not specified
    const scrollDistance = distance || Math.floor(Math.random() * 300) + 200;

    await page.evaluate((dist) => {
        window.scrollBy({
            top: dist,
            behavior: 'smooth'
        });
    }, scrollDistance);

    await humanDelay(500, 1200);
}

async function humanMouseMove(page) {
    // Simulate random mouse movement
    try {
        const randomX = Math.floor(Math.random() * 500) + 100;
        const randomY = Math.floor(Math.random() * 400) + 100;

        await page.mouse.move(randomX, randomY);
        await humanDelay(200, 500);
    } catch (e) {
        // Ignore errors
    }
}

async function simulateHumanReading(page) {
    // Simulate human reading behavior
    console.log(`      > 👁️  Simulating human reading...`);

    // Random small scrolls (like reading)
    for (let i = 0; i < Math.floor(Math.random() * 3) + 1; i++) {
        await humanScroll(page, Math.floor(Math.random() * 100) + 50);
        await humanDelay(800, 1500);
    }

    // Sometimes move mouse
    if (Math.random() > 0.5) {
        await humanMouseMove(page);
    }
}

async function tryClickCommentArea(page) {
    console.log(`      > 🖱️  Trying to click comment area...`);

    try {
        // Try multiple selectors for comment area
        const selectors = [
            'textarea[placeholder*="comment"]',
            'textarea[placeholder*="Add a comment"]',
            'textarea[aria-label*="comment"]',
            'div[role="textbox"]',
            'section:has-text("View all") button'
        ];

        for (const selector of selectors) {
            const element = page.locator(selector).first();
            const count = await element.count();

            if (count > 0) {
                // Scroll into view first (human-like)
                await element.scrollIntoViewIfNeeded().catch(() => {});
                await humanDelay(500, 1000);

                // Click to focus
                await element.click({ timeout: 3000 }).catch(() => {});
                console.log(`      > ✅ Clicked: ${selector}`);
                await humanDelay(1000, 2000);
                return true;
            }
        }

        console.log(`      > ⚠️  No comment area found`);
        return false;

    } catch (e) {
        console.log(`      > ⚠️  Click failed: ${e.message}`);
        return false;
    }
}

async function tryViewMoreComments(page) {
    try {
        // Try to click "View more comments" button
        const moreButtons = [
            'button:has-text("View more comments")',
            'button:has-text("more comments")',
            'div[role="button"]:has-text("more")',
            'span:has-text("View all")'
        ];

        for (const selector of moreButtons) {
            const btn = page.locator(selector).first();
            const count = await btn.count();

            if (count > 0) {
                console.log(`      > 🖱️  Clicking "View more comments"...`);
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await humanDelay(300, 700);
                await btn.click({ timeout: 3000 }).catch(() => {});
                await humanDelay(1500, 2500);
                return true;
            }
        }

        return false;
    } catch (e) {
        return false;
    }
}

// ========== FUNGSI SCROLL KOMENTAR (v5 - HUMAN-LIKE BEHAVIOR!) ==========
async function scrollComments(page, currentPostPk) {
    console.log("   > 🔄 Mulai auto-load SEMUA komentar (HUMAN MODE)...");

    try {
        // ========== STEP 1: SIMULATE HUMAN ARRIVAL ==========
        console.log(`      > 🎭 Simulating human behavior...`);
        await humanDelay(1000, 2000); // Initial pause (human reads post first)
        await simulateHumanReading(page); // Random scrolls + mouse moves

        // ========== STEP 2: TRY TO CLICK COMMENT AREA (TRIGGER API!) ==========
        await tryClickCommentArea(page);
        await humanDelay(1500, 2500); // Wait for API to trigger

        // ========== STEP 3: TRY "VIEW MORE COMMENTS" BUTTON ==========
        await tryViewMoreComments(page);

        // ========== PRE-CHECK: BERAPA COMMENTS YANG SUDAH TERTANGKAP? ==========
        const initialCapturedCount = Array.from(allComments.values())
            .filter(c => c.post_pk === currentPostPk).length;
        
        console.log(`      > Initial captured: ${initialCapturedCount} comments`);
        
        // ========== EARLY EXIT: JIKA SUDAH DAPAT TARGET SEBELUM SCROLL! ==========
        if (initialCapturedCount >= CONFIG.MAX_COMMENTS_PER_POST) {
            console.log(`      > ✅ Target already reached (${initialCapturedCount}/${CONFIG.MAX_COMMENTS_PER_POST}), skip scroll`);
            return;
        }
        
        // DETEKSI TIPE POST: Foto vs Reel
        const isPhotoPost = await page.locator('div._aalg').first().count() > 0;
        
        if (isPhotoPost) {
            console.log("      > 📷 Terdeteksi: POST FOTO (panel kanan)");
            await scrollPhotoCommentsUntilEnd(page, currentPostPk);
        } else {
            console.log("      > 🎥 Terdeteksi: REEL (fullpage scroll)");
            await scrollReelCommentsUntilEnd(page, currentPostPk);
        }
        
        console.log("   > ✅ Selesai load semua komentar");
        
    } catch (e) {
        console.warn(`   > ⚠️  Error saat scroll: ${e.message}`);
    }
}

// --- Helper: Scroll untuk POST FOTO (FIXED 0/1 COMMENT BUG) ---
async function scrollPhotoCommentsUntilEnd(page, currentPostPk) {
    const commentPanel = page.locator('div._aalg').first();
    
    let iteration = 0;
    let stableCount = 0;
    let lastCommentCount = 0;
    const TARGET = CONFIG.MAX_COMMENTS_PER_POST;
    
    console.log(`      > Target: ${TARGET} comments`);
    
    while (iteration < 50) {
        iteration++;
        
        // ========== LAYER 3: DEBUG (First Iteration Only) ==========
        if (iteration === 1) {
            const totalCommentsInMemory = allComments.size;
            const allPostPks = Array.from(allComments.values()).map(c => String(c.post_pk));
            const uniquePostPks = [...new Set(allPostPks)];
            
            console.log(`\n      ${"─".repeat(50)}`);
            console.log(`      🔍 DEBUG SNAPSHOT (Photo Post):`);
            console.log(`      📊 Total comments in memory: ${totalCommentsInMemory}`);
            console.log(`      🎯 Looking for post_pk: "${currentPostPk}"`);
            console.log(`      📋 Unique post_pks: [${uniquePostPks.slice(0, 5).join(', ')}]`);
            console.log(`      ${"─".repeat(50)}\n`);
        }
        
        // ========== LAYER 2: SAFE COMPARISON ==========
        const currentCommentCount = Array.from(allComments.values())
            .filter(c => String(c.post_pk) === String(currentPostPk)).length;
        
        console.log(`      > Iterasi #${iteration}: ${currentCommentCount}/${TARGET} komentar`);
        
        if (currentCommentCount >= TARGET) {
            console.log(`      ✅ TARGET REACHED!`);
            break;
        }
        
        if (currentCommentCount === 0 && iteration >= 5) {
            console.log(`      ⚠️  STUCK at 0 comments after ${iteration} iterations`);
            break;
        }
        
        // ========== STOP JIKA SUDAH DAPAT TARGET! ==========
        if (currentCommentCount >= TARGET) {
            console.log(`      > ✅ Target tercapai! Berhenti scroll.`);
            break;
        }
        
        // ========== FIX: STOP JIKA STUCK DI 0 TERLALU LAMA ==========
        if (currentCommentCount === 0 && iteration >= 5) {
            console.log(`      > ⚠️  Still 0 comments after ${iteration} iterations, stopping`);
            console.log(`      > 💡 Possible causes: Private comments, API delay, or post has no comments`);
            break;
        }
        
        // ========== HUMAN-LIKE SCROLL IN PANEL ==========
        try {
            await commentPanel.evaluate(node => {
                // Random scroll amount (not always full)
                const scrollAmount = Math.floor(Math.random() * 200) + 150;
                node.scrollBy({
                    top: scrollAmount,
                    behavior: 'smooth'
                });
            });
        } catch (e) {
            console.log(`      > ❌ Comment panel not found, breaking loop`);
            break;
        }

        // Random human delay
        await humanDelay(1500, 3000);
        
        // Cek apakah jumlah komentar bertambah
        if (currentCommentCount === lastCommentCount) {
            stableCount++;
            
            // ========== FIX: REDUCED PATIENCE FOR LOW COMMENT COUNTS ==========
            const maxStableCount = (currentCommentCount === 0) ? 3 : 4;
            
            if (stableCount >= 2) {
                const loadMoreBtn = await page.locator('button:has-text("more comments"), button:has-text("View more")').count();
                
                if (loadMoreBtn > 0) {
                    console.log(`      > 🖱️  Klik "Load more comments"...`);
                    // Human-like: scroll to button, wait, then click
                    await page.locator('button:has-text("more comments"), button:has-text("View more")').first().scrollIntoViewIfNeeded().catch(() => {});
                    await humanDelay(500, 1000);
                    await page.locator('button:has-text("more comments"), button:has-text("View more")').first().click();
                    await humanDelay(2000, 3500);
                    stableCount = 0;
                } else if (stableCount >= maxStableCount) {
                    console.log(`      > ✅ Tidak ada komentar lagi (stable ${stableCount}x)`);
                    break;
                }
            }
        } else {
            stableCount = 0;
            lastCommentCount = currentCommentCount;
        }
    }
}

// --- Helper: Scroll untuk REEL (FIXED 0/1 COMMENT BUG) ---
async function scrollReelCommentsUntilEnd(page, currentPostPk) {
    let iteration = 0;
    let stableCount = 0;
    let lastCommentCount = 0;
    let lastHeight = 0;
    const TARGET = CONFIG.MAX_COMMENTS_PER_POST;
    
    console.log(`      > Target: ${TARGET} comments`);
    
    while (iteration < 50) {
        iteration++;
        
        // ========== LAYER 3: COMPREHENSIVE DEBUG (First Iteration Only) ==========
        if (iteration === 1) {
            const totalCommentsInMemory = allComments.size;
            const allPostPks = Array.from(allComments.values()).map(c => String(c.post_pk));
            const uniquePostPks = [...new Set(allPostPks)];
            
            console.log(`\n      ${"─".repeat(50)}`);
            console.log(`      🔍 DEBUG SNAPSHOT:`);
            console.log(`      📊 Total comments in memory: ${totalCommentsInMemory}`);
            console.log(`      🎯 Looking for post_pk: "${currentPostPk}" (type: ${typeof currentPostPk})`);
            console.log(`      📋 Unique post_pks in memory: [${uniquePostPks.slice(0, 5).join(', ')}${uniquePostPks.length > 5 ? '...' : ''}]`);
            
            // ========== LAYER 4: TYPE MISMATCH DETECTION ==========
            const typeMatches = allPostPks.filter(pk => pk === currentPostPk).length;
            const valueMatches = allPostPks.filter(pk => String(pk) === String(currentPostPk)).length;
            
            if (valueMatches > 0 && typeMatches === 0) {
                console.log(`      ⚠️  WARNING: Type mismatch detected!`);
                console.log(`      💡 Found ${valueMatches} comments with matching VALUE but different TYPE`);
                console.log(`      🔧 Fix applied: Using String() normalization`);
            } else if (valueMatches === 0) {
                console.log(`      ⚠️  WARNING: No matching post_pk found at all!`);
                console.log(`      💡 Possible causes:`);
                console.log(`         - Comments not loaded yet (need more scroll)`);
                console.log(`         - Wrong post_pk (check post.post_pk value)`);
                console.log(`         - API listener not capturing (check Network tab)`);
            }
            console.log(`      ${"─".repeat(50)}\n`);
        }
        
        // ========== LAYER 2: SAFE COMPARISON WITH STRING NORMALIZATION ==========
        const currentCommentCount = Array.from(allComments.values())
            .filter(c => String(c.post_pk) === String(currentPostPk)).length;
        
        console.log(`      > Iterasi #${iteration}: ${currentCommentCount}/${TARGET} komentar`);
        
        // ========== EARLY EXIT: Target Reached ==========
        if (currentCommentCount >= TARGET) {
            console.log(`      ✅ TARGET REACHED! Stopping scroll.`);
            break;
        }
        
        // ========== EARLY EXIT: Stuck at 0 for Too Long ==========
        if (currentCommentCount === 0 && iteration >= 5) {
            console.log(`\n      ⚠️  STUCK at 0 comments after ${iteration} iterations`);
            console.log(`      💡 Debugging checklist:`);
            console.log(`         1. Check Network tab for /comments/ requests`);
            console.log(`         2. Verify post has public comments (not private)`);
            console.log(`         3. Try manual scroll to trigger API`);
            console.log(`         4. Check if listener is active (see [API REST PARENT] logs)`);
            break;
        }
        
        // ========== STOP JIKA SUDAH DAPAT TARGET! ==========
        if (currentCommentCount >= TARGET) {
            console.log(`      > ✅ Target tercapai! Berhenti scroll.`);
            break;
        }
        
        // ========== FIX: STOP JIKA STUCK DI 0 TERLALU LAMA ==========
        if (currentCommentCount === 0 && iteration >= 5) {
            console.log(`      > ⚠️  Still 0 comments after ${iteration} iterations, stopping`);
            console.log(`      > 💡 Possible causes: Private comments, API delay, or reel has no comments`);
            break;
        }
        
        // ========== HUMAN-LIKE SCROLL (SMOOTH & RANDOM) ==========
        const newHeight = await page.evaluate(() => {
            const currentHeight = window.scrollY + window.innerHeight;
            const maxHeight = document.body.scrollHeight;

            // Random scroll amount (not always to bottom)
            const scrollAmount = Math.min(
                maxHeight - currentHeight,
                Math.floor(Math.random() * 400) + 300
            );

            window.scrollBy({
                top: scrollAmount,
                behavior: 'smooth'
            });

            return document.body.scrollHeight;
        });

        // Random human delay
        await humanDelay(1500, 3000);
        
        if (newHeight === lastHeight) {
            stableCount++;
            
            // ========== FIX: REDUCED PATIENCE FOR LOW COMMENT COUNTS ==========
            const maxStableCount = (currentCommentCount === 0) ? 3 : 4;
            
            if (stableCount >= 2) {
                const loadMoreBtn = await page.locator('button:has-text("more comments")').count();

                if (loadMoreBtn > 0) {
                    // Human-like: scroll to button, wait, then click
                    await page.locator('button:has-text("more comments")').first().scrollIntoViewIfNeeded().catch(() => {});
                    await humanDelay(500, 1000);
                    await page.locator('button:has-text("more comments")').first().click();
                    await humanDelay(2000, 3500);
                    stableCount = 0;
                } else if (stableCount >= maxStableCount) {
                    console.log(`      > ✅ End of comments (stable ${stableCount}x)`);
                    break;
                }
            }
        } else {
            stableCount = 0;
            lastHeight = newHeight;
        }
        
        // Update last count
        if (currentCommentCount !== lastCommentCount) {
            lastCommentCount = currentCommentCount;
        }
    }
}

// ========== EXPAND REPLIES DISABLED (ONLY PARENT COMMENTS) ==========
async function expandAllReplies(page) {
    console.log("   > ⏭️  SKIP: Child comments disabled (parent only mode)");
    return; // Do nothing
}

// Jalankan fungsi main
main();