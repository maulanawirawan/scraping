// facebook.js (Versi 7.0 - TIMESTAMP FIX + MULTI CSV + ENHANCED DEBUG)
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { createObjectCsvWriter } = require('csv-writer');
const csvParser = require('csv-parser');
const ObjectsToCsv = require('objects-to-csv');
const fs = require('fs');

// ======== KONFIGURASI ========
const CONFIG = {
    // Credentials (nanti bisa dienkripsi)
    fb_username: "catharinawijaya36@gmail.com",
    fb_password: "UrLoVeRUrB@Ebook",
    
    // ✅ GANTI JADI:
    account_urls: [
        "https://www.facebook.com/DediMulyadi1971",
        "https://www.facebook.com/FadliZonPage",
        "https://www.facebook.com/obon.tabroni"
    ],

    // ✅ HISTORICAL - Komprehensif tapi manageable
    max_posts_historical: 1000,  // ⬇️ dari 1000 → 200 per query (800 total per year)

    max_posts_per_account: 100,  // ✅ TAMBAH INI
    // ✅ RECENT - Sustainable untuk 24/7
    max_posts_recent: 200,       // ⬇️ dari 1000 → 50 per query (200 total per cycle)
    
    // ✅ TIMING - Lebih aman dari rate limit
    JEDA_SCROLL_DETIK: 5,       // ⬆️ dari 5 → 8 detik (less aggressive)
    JEDA_ANTAR_QUERY_MENIT: 3,  // ⬆️ dari 3 → 5 menit (more breathing room)
    JEDA_ANTAR_SIKLUS_MENIT: 20, // ⬆️ dari 15 → 30 menit (sustainable)
    JEDA_UPDATE_MENIT: 30,      // ⬆️ dari 15 → 30 menit (match cycle time)
    
    // ✅ UPDATE - Lebih banyak sekaligus
    UPDATE_BATCH_SIZE: 20,      // ⬆️ dari 20 → 40 (more efficient)
    
    // CSV Settings
    csv_base_folder: "./facebook_data",
    csv_historical_prefix: "posts_",
    csv_recent_filename: "recent_posts.csv",

    // ✅ NEW: SNA SETTINGS
    ENABLE_SNA: true,  // Enable Social Network Analysis
    SNA_FILENAME: "facebook_sna_relations.xlsx",  // Output SNA file
    SNA_RELATIONS: {
        mention: true,        // Track @mentions
        hashtag: true,        // Track #hashtags
        comment: true,        // Track comments (who comments on whose post)
        reply: true,          // Track replies (who replies to whose comment)
        author_mention: true, // Track when author mentions others in their post
        tag: true            // Track tags in posts
    },

    // Debug & Filter
    DEBUG_MODE: false,
    USE_DATE_FILTER: false,
    FILTER_YEARS: [],
    SKIP_HISTORICAL: true,
    CUTOFF_DATE: '2023-05-01',
    FIRST_RUN_FILE: 'first_run_done.flag',
    MAX_SAME_POSTS_SCROLL: 3,
    
    // ✅ TAMBAH INI (baru):
    EXTRACT_COMMENTS: true,
    MAX_COMMENTS_PER_POST: 50,
    COMMENT_SCROLL_DELAY: 2500,
    COMMENT_LOADING_TIMEOUT: 10000,   // ✅ NEW: Max wait for loading (10s)

    // ✅ NEW: ERROR HANDLING & RETRY
    MAX_RETRIES: 3,              // Retry 3x jika error
    RETRY_DELAY_MINUTES: 5,      // Jeda 5 menit sebelum retry
    COOLDOWN_ON_ERROR: 15,       // Cooldown 15 menit jika max retry
    
    // ✅ NEW: RATE LIMITING
    MAX_REQUESTS_PER_HOUR: 500,  // Max 500 requests per jam
    
    // ✅ NEW: BACKUP SYSTEM
    BACKUP_ENABLED: true,
    BACKUP_DIR: './backups',
    BACKUP_INTERVAL_HOURS: 6,    // Backup setiap 6 jam
    BACKUP_KEEP_DAYS: 7,         // Simpan backup 7 hari terakhir
    
    // ✅ NEW: LOGGING
    LOG_DIR: './logs',
    LOG_LEVEL: 'INFO',           // DEBUG, INFO, WARN, ERROR
    
    // ✅ NEW: FILE PERMISSIONS
    FILE_PERMISSIONS: 0o664,     // rw-rw-r--
    
    // ✅ NEW: SCREENSHOT ON ERROR
    SCREENSHOT_ON_ERROR: true,
    SCREENSHOT_DIR: './screenshots',
    MAX_SCREENSHOTS: 50,         // Keep last 50 screenshots only
};

let isJobRunning = false;
let allScrapedUrls = new Set();
let isFirstRunDone = false;

// ✅ NEW: Global SNA Relations Storage
let allSNARelations = [];

// ✅ NEW: Progress tracking
const PROGRESS_FILE = './scraper_progress.json';

function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_FILE)) {
            const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
            console.log('📂 Progress loaded:');
            console.log(`   • Last Account: ${progress.lastAccountUrl || 'None'} (index: ${progress.lastAccountIndex})`);
            console.log(`   • Last Post: #${progress.lastPostIndex}`);
            console.log(`   • Last Run: ${progress.lastTimestamp || 'N/A'}`);
            return progress;
        }
    } catch (e) {
        console.warn(`⚠️ Error loading progress: ${e.message}`);
    }
    
    return {
        lastAccountIndex: 0,
        lastPostIndex: 0,
        lastAccountUrl: null,
        lastTimestamp: null
    };
}

function saveProgress(accountIndex, postIndex, accountUrl) {
    try {
        const progress = {
            lastAccountIndex: accountIndex,
            lastPostIndex: postIndex,
            lastAccountUrl: accountUrl,
            lastTimestamp: new Date().toISOString()
        };
        
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        fs.chmodSync(PROGRESS_FILE, CONFIG.FILE_PERMISSIONS);
        
    } catch (e) {
        console.error(`❌ Error saving progress: ${e.message}`);
    }
}

function resetProgress() {
    try {
        if (fs.existsSync(PROGRESS_FILE)) {
            fs.unlinkSync(PROGRESS_FILE);
            console.log('🔄 Progress reset');
        }
    } catch (e) {}
}

// ======== ✅ STRATEGY TRACKING SYSTEM - AUTO UPDATE ========
const strategyStats = {
    reactions: {},
    comments: {},
    shares: {},
    views: {},
    timestamp: {},
    location: {},
    url: {},
    author: {},
    content: {}
};

let totalPostsProcessed = 0; // Track total posts untuk report

/**
 * ✅ Track strategy usage (HANYA LOG, TIDAK UBAH LOGIC)
 */
function trackStrategy(category, strategyName) {
    if (!strategyStats[category]) {
        strategyStats[category] = {};
    }
    if (!strategyStats[category][strategyName]) {
        strategyStats[category][strategyName] = 0;
    }
    strategyStats[category][strategyName]++;
}

/**
 * ✅ Save strategy report (AUTO-UPDATE FILE)
 */
function saveStrategyReport() {
    try {
        const reportData = {
            generated_at: new Date().toISOString(),
            total_posts_processed: totalPostsProcessed,
            total_cycles: stats.cycleCount,
            summary: {},
            detailed: strategyStats,
            recommendations: {}
        };
        
        // Generate summary per category
        for (const [category, strategies] of Object.entries(strategyStats)) {
            const entries = Object.entries(strategies);
            const total = entries.reduce((sum, [_, count]) => sum + count, 0);
            
            if (total === 0) continue;
            
            entries.sort((a, b) => b[1] - a[1]);
            
            const topStrategy = entries[0];
            const unusedStrategies = entries.filter(([_, count]) => {
                const percentage = (count / total) * 100;
                return percentage < 5;
            }).map(([name, count]) => ({ name, count, percentage: ((count/total)*100).toFixed(1) }));
            
            reportData.summary[category] = {
                total_uses: total,
                total_strategies: entries.length,
                most_used: {
                    name: topStrategy[0],
                    count: topStrategy[1],
                    percentage: ((topStrategy[1] / total) * 100).toFixed(1) + '%'
                },
                top_3: entries.slice(0, 3).map(([name, count]) => ({
                    name,
                    count,
                    percentage: ((count/total)*100).toFixed(1) + '%'
                })),
                unused_count: unusedStrategies.length,
                candidates_for_removal: unusedStrategies
            };
            
            // Recommendations
            const keepStrategies = entries.filter(([_, count]) => (count/total)*100 >= 20).map(([name]) => name);
            const reviewStrategies = entries.filter(([_, count]) => {
                const pct = (count/total)*100;
                return pct >= 5 && pct < 20;
            }).map(([name]) => name);
            const removeStrategies = unusedStrategies.map(s => s.name);
            
            reportData.recommendations[category] = {
                keep: keepStrategies,
                review: reviewStrategies,
                remove: removeStrategies
            };
        }
        
        // Save JSON (for machine reading)
        const jsonFile = './strategy_report.json';
        fs.writeFileSync(jsonFile, JSON.stringify(reportData, null, 2));
        fs.chmodSync(jsonFile, CONFIG.FILE_PERMISSIONS);
        
        // Save TXT (for human reading)
        const txtFile = './strategy_report.txt';
        let txtContent = `
╔═══════════════════════════════════════════════════════════════════╗
║              📊 STRATEGY USAGE REPORT                            ║
║              Auto-generated: ${new Date().toLocaleString('id-ID')}           
╚═══════════════════════════════════════════════════════════════════╝

📈 OVERVIEW
─────────────────────────────────────────────────────────────────────
Total Posts Processed: ${totalPostsProcessed}
Total Cycles Completed: ${stats.cycleCount}
Report Generated: ${reportData.generated_at}

`;

        for (const [category, summary] of Object.entries(reportData.summary)) {
            txtContent += `
╔═══════════════════════════════════════════════════════════════════╗
║  📌 ${category.toUpperCase().padEnd(62)} ║
╚═══════════════════════════════════════════════════════════════════╝

📊 Statistics:
   • Total Uses: ${summary.total_uses}
   • Total Strategies: ${summary.total_strategies}
   • Unused Strategies: ${summary.unused_count}

🏆 Top 3 Most Used:
`;
            summary.top_3.forEach((strat, i) => {
                const bar = "█".repeat(Math.floor(parseFloat(strat.percentage) / 2));
                txtContent += `   ${i+1}. ${strat.name.padEnd(40)} ${strat.count.toString().padStart(5)} (${strat.percentage.padStart(5)}%) ${bar}\n`;
            });
            
            const recs = reportData.recommendations[category];
            
            if (recs.keep.length > 0) {
                txtContent += `\n✅ KEEP (≥20% usage):\n`;
                recs.keep.forEach(name => txtContent += `   • ${name}\n`);
            }
            
            if (recs.review.length > 0) {
                txtContent += `\n⚠️  REVIEW (5-20% usage):\n`;
                recs.review.forEach(name => txtContent += `   • ${name}\n`);
            }
            
            if (recs.remove.length > 0) {
                txtContent += `\n❌ CANDIDATES FOR REMOVAL (<5% usage):\n`;
                recs.remove.forEach(name => txtContent += `   • ${name}\n`);
            }
        }
        
        txtContent += `
─────────────────────────────────────────────────────────────────────
Legend:
  ✅ KEEP     - Used ≥20% (core strategy, definitely keep)
  ⚠️  REVIEW   - Used 5-20% (consider keeping for edge cases)
  ❌ REMOVE?  - Used <5% (safe to remove, rarely used)
─────────────────────────────────────────────────────────────────────

💡 TIP: Strategies marked "REMOVE" dapat dihapus untuk simplify code.
        Backup code sebelum menghapus!
`;
        
        fs.writeFileSync(txtFile, txtContent);
        fs.chmodSync(txtFile, CONFIG.FILE_PERMISSIONS);
        
        console.log(`💾 Strategy report updated:`);
        console.log(`   • JSON: ${jsonFile}`);
        console.log(`   • TXT:  ${txtFile}`);
        
    } catch (e) {
        console.error(`❌ Failed to save strategy report: ${e.message}`);
    }
}

/**
 * ✅ UPDATED: Create backup WITHOUT cache file
 */
async function createBackup() {
    if (!CONFIG.BACKUP_ENABLED) return;
    
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + 
                         new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
        const backupFolder = path.join(CONFIG.BACKUP_DIR, `backup_${timestamp}`);
        
        // Create backup folder
        if (!fs.existsSync(backupFolder)) {
            fs.mkdirSync(backupFolder, { recursive: true });
        }
        
        let backedUpFiles = 0;
        
        // ========== BACKUP CSV FILES ==========
        if (fs.existsSync(CONFIG.csv_base_folder)) {
            const csvFiles = fs.readdirSync(CONFIG.csv_base_folder)
                .filter(f => f.endsWith('.csv'));
            
            console.log(`      • CSV files: ${csvFiles.length} files`);
            
            for (const file of csvFiles) {
                const src = path.join(CONFIG.csv_base_folder, file);
                const dest = path.join(backupFolder, file);
                
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, dest);
                    fs.chmodSync(dest, CONFIG.FILE_PERMISSIONS);
                    backedUpFiles++;
                }
            }
        }
        
        
        // ========== BACKUP STATS FILE ==========
        if (fs.existsSync('./stats.json')) {
            fs.copyFileSync('./stats.json', path.join(backupFolder, 'stats.json'));
            fs.chmodSync(path.join(backupFolder, 'stats.json'), CONFIG.FILE_PERMISSIONS);
            backedUpFiles++;
            console.log(`      • Stats file: BACKED UP`);
        }
        
        console.log(`✅ Backup created: ${backupFolder} (${backedUpFiles} files)`);
        
        // Clean old backups
        cleanOldBackups(CONFIG.BACKUP_KEEP_DAYS);
        
    } catch (e) {
        console.error(`❌ Backup failed: ${e.message}`);
    }
}

/**
 * ✅ NEW: Remove backups older than N days
 */
function cleanOldBackups(keepDays) {
    try {
        if (!fs.existsSync(CONFIG.BACKUP_DIR)) return;
        
        const backups = fs.readdirSync(CONFIG.BACKUP_DIR)
            .filter(f => f.startsWith('backup_'))
            .map(f => ({
                name: f,
                path: path.join(CONFIG.BACKUP_DIR, f),
                time: fs.statSync(path.join(CONFIG.BACKUP_DIR, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);
        
        const cutoffTime = Date.now() - (keepDays * 24 * 60 * 60 * 1000);
        let removed = 0;
        
        backups.forEach(backup => {
            if (backup.time < cutoffTime) {
                fs.rmSync(backup.path, { recursive: true, force: true });
                removed++;
            }
        });
        
        if (removed > 0) {
            console.log(`🧹 Cleaned ${removed} old backup(s)`);
        }
        
    } catch (e) {
        console.error(`⚠️ Backup cleanup failed: ${e.message}`);
    }
}

/**
 * ✅ NEW: Enhanced logging with levels and file output
 */
function log(level, message, data = {}) {
    const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    const configLevel = levels[CONFIG.LOG_LEVEL] || 1;
    
    if (levels[level] < configLevel) return; // Skip if below threshold
    
    const timestamp = new Date().toISOString();
    const emoji = { DEBUG: '🔍', INFO: 'ℹ️', WARN: '⚠️', ERROR: '❌' }[level] || 'ℹ️';
    
    // Console output
    console.log(`${emoji} [${timestamp}] [${level}] ${message}`);
    if (Object.keys(data).length > 0) {
        console.log('   Data:', JSON.stringify(data, null, 2));
    }
    
    // File output
    try {
        if (!fs.existsSync(CONFIG.LOG_DIR)) {
            fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });
        }
        
        const logFile = path.join(CONFIG.LOG_DIR, `scraper_${new Date().toISOString().split('T')[0]}.log`);
        const logEntry = JSON.stringify({ timestamp, level, message, ...data }) + '\n';
        
        fs.appendFileSync(logFile, logEntry);
        
        // Rotate log files (keep last 30 days)
        rotateLogs(30);
        
    } catch (e) {
        console.error(`Log write failed: ${e.message}`);
    }
}

/**
 * ✅ NEW: Rotate old log files
 */
function rotateLogs(keepDays) {
    try {
        if (!fs.existsSync(CONFIG.LOG_DIR)) return;
        
        const logs = fs.readdirSync(CONFIG.LOG_DIR)
            .filter(f => f.startsWith('scraper_') && f.endsWith('.log'))
            .map(f => ({
                name: f,
                path: path.join(CONFIG.LOG_DIR, f),
                time: fs.statSync(path.join(CONFIG.LOG_DIR, f)).mtime.getTime()
            }));
        
        const cutoffTime = Date.now() - (keepDays * 24 * 60 * 60 * 1000);
        
        logs.forEach(log => {
            if (log.time < cutoffTime) {
                fs.unlinkSync(log.path);
            }
        });
        
    } catch (e) {
        // Silent fail untuk log rotation
    }
}


/**
 * ✅ NEW: Rate limiting tracker
 */
let requestsThisHour = 0;
let hourStartTime = Date.now();

async function checkRateLimit() {
    const now = Date.now();
    const hourElapsed = (now - hourStartTime) / (1000 * 60 * 60);
    
    // Reset counter setiap jam
    if (hourElapsed >= 1) {
        log('INFO', `Rate limit reset: ${requestsThisHour} requests in last hour`);
        requestsThisHour = 0;
        hourStartTime = now;
    }
    
    // Check if over limit
    if (requestsThisHour >= CONFIG.MAX_REQUESTS_PER_HOUR) {
        const waitTime = Math.ceil((1 - hourElapsed) * 60); // menit
        log('WARN', `Rate limit reached (${requestsThisHour}/${CONFIG.MAX_REQUESTS_PER_HOUR})`, {
            waitTime: `${waitTime} minutes`
        });
        
        console.log(`⏸️  Cooling down for ${waitTime} minutes...`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 60 * 1000));
        
        requestsThisHour = 0;
        hourStartTime = Date.now();
    }
    
    requestsThisHour++;
}

/**
 * ✅ NEW: Screenshot on error with cleanup
 */
async function captureErrorScreenshot(page, errorContext, postIndex = null) {
    if (!CONFIG.SCREENSHOT_ON_ERROR) return null;
    
    try {
        if (!fs.existsSync(CONFIG.SCREENSHOT_DIR)) {
            fs.mkdirSync(CONFIG.SCREENSHOT_DIR, { recursive: true });
        }
        
        const timestamp = Date.now();
        const postInfo = postIndex !== null ? `_post${postIndex}` : '';
        const filename = path.join(
            CONFIG.SCREENSHOT_DIR, 
            `error_${errorContext}${postInfo}_${timestamp}.png`
        );
        
        await page.screenshot({ path: filename, fullPage: false });
        fs.chmodSync(filename, CONFIG.FILE_PERMISSIONS);
        
        log('DEBUG', `Screenshot captured: ${filename}`);
        
        // Cleanup old screenshots
        const screenshots = fs.readdirSync(CONFIG.SCREENSHOT_DIR)
            .filter(f => f.startsWith('error_') && f.endsWith('.png'))
            .map(f => ({
                name: f,
                path: path.join(CONFIG.SCREENSHOT_DIR, f),
                time: fs.statSync(path.join(CONFIG.SCREENSHOT_DIR, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);
        
        // Keep only last N screenshots
        if (screenshots.length > CONFIG.MAX_SCREENSHOTS) {
            screenshots.slice(CONFIG.MAX_SCREENSHOTS).forEach(s => {
                fs.unlinkSync(s.path);
            });
        }
        
        return filename;
        
    } catch (e) {
        log('WARN', `Screenshot failed: ${e.message}`);
        return null;
    }
}

/**
 * ✅ NEW: Wrap runJob with retry mechanism
 */
async function runJobWithRetry() {
    let retries = 0;
    
    while (retries < CONFIG.MAX_RETRIES) {
        try {
            log('INFO', `Starting job (attempt ${retries + 1}/${CONFIG.MAX_RETRIES})`);
            await runJob();
            log('INFO', 'Job completed successfully');
            return true; // Success
            
        } catch (error) {
            retries++;
            log('ERROR', `Job failed (attempt ${retries}/${CONFIG.MAX_RETRIES})`, {
                error: error.message,
                stack: error.stack?.substring(0, 300)
            });
            
            if (retries < CONFIG.MAX_RETRIES) {
                const delay = CONFIG.RETRY_DELAY_MINUTES * 60 * 1000;
                console.log(`🔄 Retrying in ${CONFIG.RETRY_DELAY_MINUTES} minutes...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                log('ERROR', 'Max retries reached, entering cooldown', {
                    cooldown: `${CONFIG.COOLDOWN_ON_ERROR} minutes`
                });
                
                console.error(`💥 Max retries reached. Cooldown for ${CONFIG.COOLDOWN_ON_ERROR} minutes...`);
                await new Promise(resolve => 
                    setTimeout(resolve, CONFIG.COOLDOWN_ON_ERROR * 60 * 1000)
                );
            }
        }
    }
    
    return false;
}


/**
 * ✅ NEW: Statistics tracking
 */
const stats = {
    startTime: Date.now(),
    totalScraped: 0,
    totalErrors: 0,
    totalRetries: 0,
    lastSuccessfulRun: null,
    lastErrorTime: null,
    cycleCount: 0,
    postsPerCycle: [],
    errorsPerCycle: []
};

/**
 * ✅ NEW: Save stats to file
 */
function saveStats() {
    try {
        const uptime = Date.now() - stats.startTime;
        const statsData = {
            ...stats,
            uptimeHours: (uptime / (1000 * 60 * 60)).toFixed(2),
            uptimeDays: (uptime / (1000 * 60 * 60 * 24)).toFixed(2),
            avgPostsPerCycle: stats.postsPerCycle.length > 0 
                ? (stats.postsPerCycle.reduce((a, b) => a + b, 0) / stats.postsPerCycle.length).toFixed(2)
                : 0,
            successRate: stats.cycleCount > 0
                ? ((stats.cycleCount - stats.totalRetries) / stats.cycleCount * 100).toFixed(2) + '%'
                : '0%',
            lastUpdated: new Date().toISOString()
        };
        
        fs.writeFileSync('./stats.json', JSON.stringify(statsData, null, 2));
        fs.chmodSync('./stats.json', CONFIG.FILE_PERMISSIONS);
        
    } catch (e) {
        log('WARN', `Stats save failed: ${e.message}`);
    }
}

/**
 * ✅ NEW: Update stats after each cycle
 */
function updateStats(scraped, errors) {
    stats.cycleCount++;
    stats.totalScraped += scraped;
    stats.totalErrors += errors;
    
    if (scraped > 0) {
        stats.lastSuccessfulRun = new Date().toISOString();
    }
    
    stats.postsPerCycle.push(scraped);
    stats.errorsPerCycle.push(errors);
    
    // Keep only last 100 cycles
    if (stats.postsPerCycle.length > 100) {
        stats.postsPerCycle.shift();
        stats.errorsPerCycle.shift();
    }
    
    saveStats();
}


// Pastikan folder exists
if (!fs.existsSync(CONFIG.csv_base_folder)) {
    fs.mkdirSync(CONFIG.csv_base_folder, { recursive: true });
}

/**
 * ✅ Clean text untuk CSV (aggressive newline removal)
 */
function cleanTextForCSV(text) {
    if (!text) return "";
    
    let cleaned = String(text)
        .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
        .trim();
    
    // Escape quotes untuk CSV
    cleaned = cleaned.replace(/"/g, '""');
    
    return cleaned;
}


/**
 * Extract reaction count from comment element
 * @param {ElementHandle} commentEl - Comment element
 * @returns {Promise<number>} Number of reactions (0 if none)
 */
async function extractCommentReactions(commentEl) {
    try {
        // ✅ PRIORITY: Extract from aria-label (most reliable)
        const reactionSelectors = [
            // Strategy 1: Exact match dari HTML user
            'div[aria-label*="reaction"][role="button"]',
            // Strategy 2: Broader
            'div[aria-label*="reaction"]',
        ];
        
        for (const selector of reactionSelectors) {
            const reactionEl = commentEl.locator(selector).first();
            
            if (await reactionEl.count() > 0) {
                // ✅ CRITICAL: Parse aria-label correctly
                const ariaLabel = await reactionEl.getAttribute('aria-label').catch(() => null);
                
                if (ariaLabel) {
                    // Example: "1 reaction; see who reacted to this"
                    // Example: "71 reactions; see who reacted to this"
                    const match = ariaLabel.match(/(\d+)\s+reactions?/i);
                    if (match) {
                        return parseInt(match[1], 10);
                    }
                }
            }
        }
        
        return 0;
        
    } catch (error) {
        return 0;
    }
}

/**
 * ✅ FIXED: Save comments to separate CSV file
 * @param {Array} comments - Array of comment objects
 * @param {string} postAuthor - Author of the post
 * @param {string} postUrl - URL of the post
 * @param {string} outputDir - Output directory path
 */
async function saveCommentsToCSV(comments, postAuthor, postUrl, outputDir) {
    if (!comments || comments.length === 0) {
        return;
    }
    
    const commentsFilePath = path.join(outputDir, 'comments.csv');
    const fileExists = fs.existsSync(commentsFilePath);
    
    // ✅ FIXED: Prepare rows with CORRECT field names
    const rows = comments.map(comment => ({
        post_author: postAuthor,
        post_url: postUrl,
        comment_author: comment.comment_author || 'Unknown',
        comment_text: comment.comment_text || '',              // ✅ FIXED!
        comment_reactions: comment.comment_reactions || 0,     // ✅ FIXED!
        comment_timestamp: comment.comment_timestamp || 'N/A', // ✅ FIXED!
    }));
    
    // Convert to CSV
    const csv = new ObjectsToCsv(rows);
    
    if (fileExists) {
        // Append to existing file
        await csv.toDisk(commentsFilePath, { append: true });
    } else {
        // Create new file with headers
        await csv.toDisk(commentsFilePath);
    }
    
    console.log(`      💾 Saved ${comments.length} comment(s) to comments.csv`);
}


/**
 * ✅ NEW: Update single post (engagement + new comments)
 * @param {Page} page - Main page
 * @param {string} postUrl - Post URL to update
 * @param {string} csvFile - CSV file path
 * @returns {Promise<boolean>} Success status
 */
async function updateSinglePost(page, postUrl, csvFile) {
    console.log(`\n🔄 Updating post: ${postUrl.substring(0, 70)}...`);
    
    try {
        // ========== STEP 1: Load existing data from CSV ==========
        const existingPosts = [];
        
        if (fs.existsSync(csvFile)) {
            await new Promise((resolve) => {
                fs.createReadStream(csvFile)
                    .pipe(csvParser())
                    .on('data', (row) => existingPosts.push(row))
                    .on('end', resolve);
            });
        }
        
        // Find existing post
        const existingPost = existingPosts.find(p => 
            p.post_url === postUrl || 
            p.share_url === postUrl
        );
        
        if (!existingPost) {
            console.log(`   ⚠️ Post not found in CSV, skipping`);
            return false;
        }
        
        console.log(`   ✓ Found existing post by: ${existingPost.author}`);
        
        // ========== STEP 2: Open post page ==========
        const gotoResult = await page.goto(postUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        }).catch(() => null);
        
        if (!gotoResult) {
            console.log(`   ⚠️ Could not load post`);
            return false;
        }
        
        await page.waitForTimeout(3000);
        await page.waitForSelector('div[role="main"]', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);
        
        // ========== STEP 3: Extract updated engagement ==========
        const postEl = page.locator('div[role="main"]').first();
        
        const reactions = await extractReactions(postEl, page, 0);
        const comments = await extractComments(postEl, page, 0);
        const shares = await extractShares(postEl, page, 0);
        
        console.log(`   📊 Engagement: R:${reactions} C:${comments} S:${shares}`);
        
        // ========== STEP 4: Load existing comments from comments.csv ==========
        const commentsFile = path.join(CONFIG.csv_base_folder, 'comments.csv');
        const existingComments = new Set();
        
        if (fs.existsSync(commentsFile)) {
            await new Promise((resolve) => {
                fs.createReadStream(commentsFile)
                    .pipe(csvParser())
                    .on('data', (row) => {
                        if (row.post_url === postUrl) {
                            // Create fingerprint untuk detect duplicate
                            const fingerprint = `${row.comment_author}|${row.comment_text.substring(0, 50)}`;
                            existingComments.add(fingerprint);
                        }
                    })
                    .on('end', resolve);
            });
        }
        
        console.log(`   📝 Existing comments in DB: ${existingComments.size}`);
        
        // ========== STEP 5: Extract NEW comments only ==========
        if (CONFIG.EXTRACT_COMMENTS && comments > existingComments.size) {
            console.log(`   🗨️  Extracting new comments...`);
            
            const allComments = await extractAllComments(page, postEl);
            
            // Filter: Only NEW comments (not in existing)
            const newComments = allComments.filter(comment => {
                const fingerprint = `${comment.comment_author}|${comment.comment_text.substring(0, 50)}`;
                return !existingComments.has(fingerprint);
            });
            
            console.log(`   ✅ Found ${newComments.length} NEW comments`);
            
            if (newComments.length > 0) {
                await saveCommentsToCSV(
                    newComments,
                    existingPost.author,
                    postUrl,
                    CONFIG.csv_base_folder
                );
            }
        } else {
            console.log(`   ℹ️  No new comments to extract`);
        }
        
        // ========== STEP 6: Update post data in CSV ==========
        const postIndex = existingPosts.findIndex(p => 
            p.post_url === postUrl || p.share_url === postUrl
        );
        
        if (postIndex !== -1) {
            existingPosts[postIndex].reactions_total = reactions;
            existingPosts[postIndex].comments = comments;
            existingPosts[postIndex].shares = shares;
            existingPosts[postIndex].updated_at = new Date().toISOString();
            
            // Save back to CSV
            const writer = createObjectCsvWriter({
                path: csvFile,
                header: Object.keys(existingPosts[0]).map(id => ({id, title: id})),
                alwaysQuote: true,
                encoding: 'utf8'
            });
            
            await writer.writeRecords(existingPosts);
            fs.chmodSync(csvFile, CONFIG.FILE_PERMISSIONS);
            
            console.log(`   ✅ Post data updated in CSV`);
        }
        
        return true;
        
    } catch (error) {
        console.error(`   ❌ Update error: ${error.message}`);
        return false;
    }
}

/**
 * ✅ NEW: Auto-update recent posts (ScheduledJob)
 * @param {Page} page - Main page
 * @param {number} maxPostsToUpdate - Max posts to update per run
 */
async function autoUpdateRecentPosts(page, maxPostsToUpdate = 20) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`🔄 AUTO-UPDATE: Checking for posts to refresh...`);
    console.log(`${"=".repeat(70)}`);
    
    const csvFile = getCSVFilename(null); // recent_posts.csv
    
    if (!fs.existsSync(csvFile)) {
        console.log("ℹ️  No recent posts file found");
        return;
    }
    
    // Load all posts
    const posts = [];
    
    await new Promise((resolve) => {
        fs.createReadStream(csvFile)
            .pipe(csvParser())
            .on('data', (row) => posts.push(row))
            .on('end', resolve);
    });
    
    console.log(`📂 Found ${posts.length} posts in database`);
    
    // Sort by updated_at (oldest first = need update most)
    posts.sort((a, b) => {
        const dateA = new Date(a.updated_at || a.scraped_at);
        const dateB = new Date(b.updated_at || b.scraped_at);
        return dateA - dateB;
    });
    
    // Take top N oldest posts
    const postsToUpdate = posts.slice(0, maxPostsToUpdate);
    
    console.log(`🎯 Will update ${postsToUpdate.length} oldest posts\n`);
    
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < postsToUpdate.length; i++) {
        const post = postsToUpdate[i];
        const postUrl = post.share_url !== "N/A" ? post.share_url : post.post_url;
        
        console.log(`[${i + 1}/${postsToUpdate.length}] ${post.author || 'Unknown'}`);
        
        const success = await updateSinglePost(page, postUrl, csvFile);
        
        if (success) {
            successCount++;
        } else {
            errorCount++;
        }
        
        // Human-like delay
        await page.waitForTimeout(3000 + Math.random() * 2000);
    }
    
    console.log(`\n📊 Update Summary:`);
    console.log(`   • Success: ${successCount}`);
    console.log(`   • Errors: ${errorCount}`);
    console.log(`${"=".repeat(70)}\n`);
}


/**
 * ✅ Parse engagement count (handle K, M, dll)
 */
function parseEngagementCount(text) {
    if (!text) return 0;
    const cleanText = text.toLowerCase().replace(',', '.');
    const match = cleanText.match(/(\d+(\.\d+)?)/);
    if (!match) return 0;
    
    let count = parseFloat(match[0]);
    if (cleanText.includes('k') || cleanText.includes('rb')) {
        count *= 1000;
    } else if (cleanText.includes('m') || cleanText.includes('jt')) {
        count *= 1000000;
    }
    return Math.round(count);
}

/**
 * Clean URL tapi pertahankan parameter penting (fbid untuk foto)
 */
function cleanPostUrl(url) {
    if (!url) return url;
    
    // ✅ Keep share links intact (new Facebook format)
    if (url.includes('/share/v/') || url.includes('/share/p/') || url.includes('/share/r/')) {
        // Remove tracking params but keep the share ID
        return url.split('?')[0].split('&__cft__')[0].split('&__tn__')[0];
    }
    
    // ✅ Keep photo links with fbid parameter
    if (url.includes('/photo')) {
        return url.split('&__cft__')[0].split('&__tn__')[0];
    }
    
    // ✅ Keep reel/watch links with ID
    if (url.includes('/reel/') || url.includes('/watch/')) {
        return url.split('?')[0].split('&__cft__')[0].split('&__tn__')[0];
    }
    
    // Default: remove all query params
    return url.split('?')[0];
}


/**
 * ✅ Extract Post ID dari berbagai format URL Facebook
 */
function extractPostId(url) {
    if (!url) return null;
    
    try {
        const patterns = [
            // Format: /posts/pfbid...
            /\/posts\/(pfbid[\w-]+)/i,
            // Format: /photo/?fbid=123456
            /[?&]fbid=(\d+)/i,
            // Format: /photo.php?fbid=123456
            /photo\.php\?.*fbid=(\d+)/i,
            // Format: /videos/123456
            /\/videos\/(\d+)/i,
            // Format: /reel/123456
            /\/reel\/([\w-]+)/i,
            // Format: story_fbid=123456
            /story_fbid=(\d+)/i,
            // Format: /permalink/123456
            /\/permalink\/(\d+)/i,
        ];
        
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }
        
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * ✅ Extract Photo ID dari image source URL
 */
function extractPhotoIdFromImageUrl(imageUrl) {
    if (!imageUrl || imageUrl === "N/A") return null;
    
    try {
        // Pattern: 555724480_1344276150399073_178885508552628349_n.jpg
        // Ambil angka tengah (1344276150399073) yang merupakan photo ID
        const match = imageUrl.match(/\/(\d+)_(\d+)_(\d+)_[no]\.jpg/i);
        if (match && match[2]) {
            return match[2]; // Return photo ID (angka tengah)
        }
        
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * ✅ FIXED: Find duplicate in CSV files with ROBUST parsing
 */
function findDuplicateInCSV(searchKey, searchValue) {
    const csvFiles = [
        ...CONFIG.FILTER_YEARS.map(y => getCSVFilename(y)),
        getCSVFilename(null)
    ].filter(f => fs.existsSync(f));
    
    for (const csvFile of csvFiles) {
        try {
            const fileContent = fs.readFileSync(csvFile, 'utf8');
            const lines = fileContent.split('\n');
            
            // Parse header to get column indices
            const headerLine = lines[0];
            const headers = headerLine.match(/"([^"]+)"|([^,]+)/g).map(h => h.replace(/"/g, '').trim());
            
            const postUrlIndex = headers.indexOf('post_url');
            const shareUrlIndex = headers.indexOf('share_url');
            const authorIndex = headers.indexOf('author');
            const timestampIndex = headers.indexOf('timestamp');
            const scrapedAtIndex = headers.indexOf('scraped_at');
            
            // Search in data rows
            for (let lineNum = 1; lineNum < lines.length; lineNum++) {
                const line = lines[lineNum];
                
                if (!line.trim() || line.length < 50) continue; // Skip empty lines
                
                // Quick check first (performance)
                if (!line.includes(searchValue)) continue;
                
                // Parse CSV row properly
                const values = [];
                let current = '';
                let inQuotes = false;
                
                for (let i = 0; i < line.length; i++) {
                    const char = line[i];
                    
                    if (char === '"') {
                        if (inQuotes && line[i + 1] === '"') {
                            // Escaped quote
                            current += '"';
                            i++;
                        } else {
                            // Toggle quote mode
                            inQuotes = !inQuotes;
                        }
                    } else if (char === ',' && !inQuotes) {
                        // End of field
                        values.push(current.trim());
                        current = '';
                    } else {
                        current += char;
                    }
                }
                // Push last field
                values.push(current.trim());
                
                // Check if post_url matches
                const postUrl = values[postUrlIndex] || '';
                const shareUrl = values[shareUrlIndex] || '';
                
                if (postUrl.includes(searchValue) || shareUrl.includes(searchValue)) {
                    return {
                        found: true,
                        file: csvFile,
                        lineNumber: lineNum + 1, // +1 for header
                        author: values[authorIndex] || 'Unknown',
                        timestamp: values[timestampIndex] || 'N/A',
                        post_url: postUrl,
                        share_url: shareUrl,
                        scraped_at: values[scrapedAtIndex] || 'N/A'
                    };
                }
            }
        } catch (e) {
            console.warn(`      ⚠️ Error reading ${csvFile}: ${e.message.substring(0, 40)}`);
            continue;
        }
    }
    
    return { found: false };
}

/**
 * ✅ Generate content fingerprint untuk duplicate detection
 */
function generateContentFingerprint(author, timestamp, contentText, imageUrl) {
    const crypto = require('crypto');
    
    // Normalize data
    const normalizedAuthor = String(author || '').trim().toLowerCase();
    const normalizedTimestamp = String(timestamp || '').trim();
    const normalizedContent = String(contentText || '').trim().substring(0, 200);
    
    // Combine untuk hash
    const combined = `${normalizedAuthor}|${normalizedTimestamp}|${normalizedContent}`;
    const hash = crypto.createHash('md5').update(combined).digest('hex');
    
    return hash;
}

/**
 * ✅ FIXED: Convert Facebook date format ke ISO 8601
 * Handle format: "Monday 6 October 2025 at 15:37"
 */
function convertToISO(dateString) {
    if (!dateString || dateString === "N/A") {
        return null;
    }
    
    try {
        // ✅ NEW PATTERN: Handle day name di depan
        const patterns = [
            // "Monday 6 October 2025 at 15:37"
            /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*(\d{1,2})\s+(\w+)\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})/i,
            // "6 October 2025 at 15:37" (fallback)
            /(\d{1,2})\s+(\w+)\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})/i,
            // "October 6, 2025 at 15:37" (US format)
            /(\w+)\s+(\d{1,2}),?\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})/i,
        ];
        
        let match = null;
        let patternIndex = 0;
        
        for (let i = 0; i < patterns.length; i++) {
            match = dateString.match(patterns[i]);
            if (match) {
                patternIndex = i;
                break;
            }
        }
        
        if (!match) {
            console.warn(`   ⚠️ Could not parse date: ${dateString}`);
            return null;
        }
        
        let day, monthName, year, hour, minute;
        
        if (patternIndex === 2) {
            // US format: month day year
            monthName = match[1];
            day = match[2];
            year = match[3];
            hour = match[4];
            minute = match[5];
        } else {
            // Normal format: day month year
            day = match[1];
            monthName = match[2];
            year = match[3];
            hour = match[4];
            minute = match[5];
        }
        
        const months = {
            'january': '01', 'february': '02', 'march': '03', 'april': '04',
            'may': '05', 'june': '06', 'july': '07', 'august': '08',
            'september': '09', 'october': '10', 'november': '11', 'december': '12',
            'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
            'jun': '06', 'jul': '07', 'aug': '08', 'sep': '09',
            'oct': '10', 'nov': '11', 'dec': '12'
        };
        
        const month = months[monthName.toLowerCase()];
        
        if (!month) {
            console.warn(`   ⚠️ Unknown month: ${monthName}`);
            return null;
        }
        
        const isoDate = `${year}-${month}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00.000Z`;
        
        const dateObj = new Date(isoDate);
        if (isNaN(dateObj.getTime())) {
            console.warn(`   ⚠️ Invalid date constructed: ${isoDate}`);
            return null;
        }
        
        return isoDate;
        
    } catch (e) {
        console.warn(`   ⚠️ Date conversion error: ${e.message}`);
        return null;
    }
}

/**
 * ✅ FIXED: Validate timestamp - pakai ISO result
 */
function isValidTimestamp(timestamp) {
    if (!timestamp || timestamp === "N/A") {
        return false;
    }
    
    try {
        // ✅ Convert dulu ke ISO
        const isoDate = convertToISO(timestamp);
        
        if (!isoDate) {
            console.log(`      ⚠️ Cannot convert to ISO: ${timestamp}`);
            return false;
        }
        
        const postDate = new Date(isoDate);
        const cutoffDate = new Date(CONFIG.CUTOFF_DATE + 'T00:00:00.000Z');
        
        if (isNaN(postDate.getTime())) {
            console.log(`      ⚠️ Invalid date format: ${timestamp}`);
            return false;
        }
        
        if (postDate < cutoffDate) {
            console.log(`      ⏭️  SKIP: Post before ${CONFIG.CUTOFF_DATE} (${timestamp})`);
            return false;
        }
        
        return true;
    } catch (e) {
        console.warn(`      ⚠️ Date validation error: ${e.message}`);
        return false;
    }
}

/**
 * ✅ NEW: Get CSV filename based on year or recent mode
 */
function getCSVFilename(filterYear) {
    if (!filterYear || filterYear === 'recent_mode') {
        return path.join(CONFIG.csv_base_folder, CONFIG.csv_recent_filename);
    }
    return path.join(CONFIG.csv_base_folder, `${CONFIG.csv_historical_prefix}${filterYear}.csv`);
}

/**
 * Debug pause
 */
async function debugPause(message) {
    if (CONFIG.DEBUG_MODE) {
        console.log(`\n🔍 DEBUG PAUSE: ${message}`);
        console.log("Tekan Enter untuk melanjutkan...");
        await new Promise(resolve => {
            process.stdin.once('data', () => resolve());
        });
    }
}

/**
 * ✅ Human-like delay
 */
async function humanDelay(minMs = 800, maxMs = 2000) {
    const delay = minMs + Math.random() * (maxMs - minMs);
    await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Human-like mouse movement and click
 */
async function humanClick(page, element) {
    try {
        await element.scrollIntoViewIfNeeded().catch(() => {});
        await humanDelay(300, 700);
        
        const box = await element.boundingBox();
        if (box) {
            const x = box.x + (box.width * 0.3) + Math.random() * (box.width * 0.4);
            const y = box.y + (box.height * 0.3) + Math.random() * (box.height * 0.4);
            await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 8) });
            await humanDelay(200, 500);
        }
        
        await element.click({ timeout: 5000 });
        await humanDelay(500, 1000);
        
        return true;
    } catch (e) {
        console.warn(`   ⚠️ Human click error: ${e.message.substring(0, 50)}`);
        return false;
    }
}

/**
 * Click "All" tab to expand filter options
 */
async function clickAllTab(page) {
    try {
        console.log("   🎯 Clicking 'All' tab to expand filters...");
        
        const allTabSelectors = [
            'a[href*="/search/top/"][href*="__eps__=SERP_POSTS_TAB"]',
            'a[href*="/search/top/"][role="link"]:has-text("All")',
            'a[role="link"]:has(span:text-is("All"))',
            'a[href*="/search/top/"][aria-current="page"]',
            'a:has-text("All")[role="link"]',
            'span:text-is("All")',
            'a[href*="/search/top/"][role="link"]',
            'a[role="link"]:has-text("All")',
        ];
        
        for (const selector of allTabSelectors) {
            try {
                const allTab = page.locator(selector).first();
                
                const count = await allTab.count();
                if (count === 0) {
                    continue;
                }
                
                console.log(`      -> Trying selector: ${selector}`);
                
                await allTab.waitFor({ state: 'visible', timeout: 10000 });
                await allTab.scrollIntoViewIfNeeded();
                await humanDelay(1000, 1500);
                
                let clickSuccess = false;
                
                try {
                    await allTab.click({ timeout: 10000 });
                    clickSuccess = true;
                } catch (clickErr1) {
                    console.log(`         Regular click failed, trying force click...`);
                    
                    try {
                        await allTab.click({ force: true, timeout: 10000 });
                        clickSuccess = true;
                    } catch (clickErr2) {
                        console.log(`         Force click failed, trying humanClick...`);
                        clickSuccess = await humanClick(page, allTab);
                    }
                }
                
                if (clickSuccess) {
                    await humanDelay(2000, 3000);
                    console.log("   ✅ 'All' tab clicked, filters should be visible");
                    return true;
                }
                
            } catch (e) {
                console.log(`      -> Failed with selector: ${selector} (${e.message.substring(0, 30)}...)`);
                continue;
            }
        }
        
        console.log("   ℹ️ 'All' tab already active or not found");
        return false;
    } catch (error) {
        console.warn(`   ⚠️ Error clicking All tab: ${error.message}`);
        return false;
    }
}

/**
 * Enable Recent Posts toggle
 */
async function enableRecentPosts(page) {
    try {
        console.log("   🔄 Enabling 'Recent posts' toggle...");
        
        await clickAllTab(page);
        await humanDelay(1500, 2500);
        
        const recentPostsSelectors = [
            'input[aria-label="Recent posts"][role="switch"]',
            'input[aria-label="Recent posts"][type="checkbox"]',
            'div[role="switch"]:has-text("Recent posts")',
        ];
        
        for (const selector of recentPostsSelectors) {
            try {
                const toggle = page.locator(selector).first();
                const count = await toggle.count();
                
                if (count > 0) {
                    const isChecked = await toggle.getAttribute('aria-checked');
                    
                    if (isChecked === 'false') {
                        await toggle.scrollIntoViewIfNeeded().catch(() => {});
                        await humanDelay(500, 1000);
                        await toggle.click({ timeout: 5000 });
                        await humanDelay(1500, 2000);
                        console.log("   ✅ 'Recent posts' enabled");
                        return true;
                    } else {
                        console.log("   ℹ️ 'Recent posts' already enabled");
                        return true;
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        console.log("   ℹ️ 'Recent posts' toggle not found");
        return false;
    } catch (error) {
        console.warn(`   ⚠️ Error enabling recent posts: ${error.message}`);
        return false;
    }
}

/**
 * Apply date filter
 */
async function applyDateFilter(page, year) {
    try {
        console.log(`\n📅 Applying date filter: ${year}`);
        
        await clickAllTab(page);
        await humanDelay(1500, 2500);
        
        console.log("   -> Looking for 'Date posted' dropdown...");
        
        const datePostedSelectors = [
            'div[role="combobox"][aria-label*="Date posted"]',
            'div[aria-label*="Filter by Date posted"]',
            'div:has-text("Date posted")[role="combobox"]',
        ];
        
        let datePostedButton = null;
        for (const selector of datePostedSelectors) {
            try {
                const btn = page.locator(selector).first();
                await btn.waitFor({ state: 'visible', timeout: 5000 });
                if (await btn.count() > 0) {
                    datePostedButton = btn;
                    console.log(`   ✓ Found with selector: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!datePostedButton) {
            console.log("   ⚠️ Date posted button not found after clicking All tab");
            return false;
        }
        
        console.log("   -> Clicking 'Date posted' dropdown...");
        const clickSuccess = await humanClick(page, datePostedButton);
        if (!clickSuccess) {
            console.log("   ⚠️ Failed to click Date posted button");
            return false;
        }
        
        await humanDelay(2000, 3000);
        
        try {
            await page.waitForSelector('div[role="listbox"]', { timeout: 5000 });
            console.log("   -> Dropdown opened successfully");
            await humanDelay(1500, 2000);
        } catch (e) {
            console.log("   ⚠️ Dropdown menu did not appear");
            return false;
        }
        
        console.log(`   -> Looking for year ${year} option...`);
        
        try {
            const yearOption = page.locator(`div[role="option"]:has(span:text-is("${year}"))`).first();
            await yearOption.waitFor({ state: 'visible', timeout: 5000 });
            console.log(`   -> Found year ${year} via role="option"`);
            await yearOption.scrollIntoViewIfNeeded({ timeout: 3000 });
            await humanDelay(500, 1000);
            
            try {
                await yearOption.click({ timeout: 10000, trial: true });
                await yearOption.click({ timeout: 10000 });
                console.log(`   ✅ Clicked year ${year} successfully`);
                await humanDelay(2500, 3500);
                
                const filterApplied = await page.locator(`[aria-label*="${year}"]`).count() > 0;
                if (filterApplied) {
                    console.log(`   ✅ Date filter ${year} applied successfully`);
                    return true;
                } else {
                    console.log(`   ⚠️ Could not verify filter, but continuing...`);
                    return true;
                }
            } catch (clickError) {
                console.log(`   ⚠️ Regular click failed: ${clickError.message.substring(0, 50)}`);
                throw clickError;
            }
            
        } catch (error1) {
            console.log(`   -> Strategy 1 failed, trying keyboard navigation...`);
            
            try {
                const yearOption = page.locator(`div[role="option"][tabindex="0"]:has(span:text-is("${year}"))`).first();
                if (await yearOption.count() > 0) {
                    await yearOption.focus();
                    await humanDelay(500, 1000);
                    await page.keyboard.press('Enter');
                    console.log(`   ✅ Selected year ${year} via keyboard`);
                    await humanDelay(2500, 3500);
                    return true;
                } else {
                    throw new Error("Option not found");
                }
            } catch (error2) {
                console.log(`   -> Strategy 2 failed, trying force click...`);
                
                try {
                    const yearOption = page.locator(`div[role="option"]:has(span:text-is("${year}"))`).first();
                    await yearOption.scrollIntoViewIfNeeded();
                    await humanDelay(1000, 1500);
                    await yearOption.click({ force: true, timeout: 10000 });
                    console.log(`   ✅ Force clicked year ${year}`);
                    await humanDelay(2500, 3500);
                    return true;
                } catch (error3) {
                    console.log(`   -> Strategy 3 failed, trying direct span click...`);
                    
                    try {
                        const yearSpan = page.locator(`div[role="listbox"] span:text-is("${year}")`).first();
                        await yearSpan.waitFor({ state: 'visible', timeout: 5000 });
                        await yearSpan.scrollIntoViewIfNeeded();
                        await humanDelay(1000, 1500);
                        await yearSpan.click({ timeout: 10000 });
                        console.log(`   ✅ Clicked year ${year} span directly`);
                        await humanDelay(2500, 3500);
                        return true;
                    } catch (error4) {
                        console.error(`   ❌ All strategies failed: ${error4.message}`);
                        await page.keyboard.press('Escape');
                        return false;
                    }
                }
            }
        }
        
    } catch (error) {
        console.error(`   ❌ Error applying date filter: ${error.message}`);
        await page.keyboard.press('Escape').catch(() => {});
        return false;
    }
}

/**
 * Clear date filter
 */
async function clearDateFilter(page) {
    try {
        console.log("   🧹 Clearing date filter...");
        
        const clearButtonSelectors = [
            'div[aria-label="Clear Date posted Filter"][role="button"]',
            'div[aria-label*="Clear Date posted"]',
            'div[aria-label*="Clear"][aria-label*="Filter"]',
            'div:has-text("Clear")[role="button"]',
        ];
        
        for (const selector of clearButtonSelectors) {
            try {
                const clearButton = page.locator(selector).first();
                const count = await clearButton.count();
                
                if (count > 0) {
                    console.log(`      -> Found clear button with: ${selector}`);
                    await clearButton.scrollIntoViewIfNeeded().catch(() => {});
                    await humanDelay(500, 1000);
                    
                    let clicked = false;
                    
                    try {
                        await clearButton.click({ timeout: 5000 });
                        clicked = true;
                    } catch (e1) {
                        try {
                            await clearButton.click({ force: true, timeout: 5000 });
                            clicked = true;
                        } catch (e2) {
                            clicked = await humanClick(page, clearButton);
                        }
                    }
                    
                    if (clicked) {
                        await humanDelay(2000, 3000);
                        console.log("   ✅ Date filter cleared successfully");
                        return true;
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        console.log("   ℹ️ No active filter to clear");
        return true;
    } catch (error) {
        console.warn(`   ⚠️ Error clearing filter: ${error.message}`);
        return false;
    }
}

/**
 * Login ke Facebook
 */
async function loginToFacebook(page, username, password) {
    try {
        console.log("🔐 Mencoba login ke Facebook...");
        
        try {
            const cookieButton = page.locator(
                'button[data-testid="cookie-policy-manage-dialog-accept-button"], button:has-text("Allow all cookies")'
            ).first();
            await cookieButton.waitFor({ state: 'visible', timeout: 5000 });
            await cookieButton.click();
            console.log("✅ Cookie banner ditutup.");
        } catch (e) {
            console.log("ℹ️ Tidak ada cookie banner.");
        }
        
        await page.fill('#email', username);
        await page.fill('#pass', password);
        console.log("✅ Email & Password dimasukkan.");
        
        await page.getByRole('button', { name: 'Log in' }).click();
        console.log("⏳ Menunggu navigasi... (Maks 2 menit)");
        console.log("🔥🔥 PENTING: Selesaikan 2FA/CAPTCHA jika diminta SEKARANG!");
        
        await page.waitForSelector('a[aria-label="Home"]', { timeout: 120000 });
        console.log("🎉 Login berhasil!");
        return true;
    } catch (error) {
        console.error(`❌ Gagal login: ${error.message}`);
        await page.screenshot({ path: 'facebook_login_gagal.png' });
        return false;
    }
}

/**
 * Extract Location dari post
 */
async function extractLocation(postEl) {
    try {
        console.log("      -> Extracting location...");
        
        // ✅ PLACEHOLDER - Will be filled from HTML analysis
        
        return "N/A";
        
    } catch (e) {
        console.warn(`      ⚠️ Error extract location: ${e.message.substring(0, 40)}`);
        return "N/A";
    }
}


async function extractAuthor(postEl) {
    try {
        console.log("      -> Extracting author...");
        
        // ✅ Strategy 0: EXACT from HTML (highest priority)
        const exactAuthorSelector = 'span.html-span.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x1hl2dhg.x16tdsg8.x1vvkbs';
        const exactAuthor = postEl.locator(exactAuthorSelector).first();
        
        if (await exactAuthor.count() > 0) {
            const text = await exactAuthor.textContent();
            if (text && text.trim()) {
                const authorName = cleanTextForCSV(text.trim());
                console.log`      -> Author (exact): ${authorName}`;
                trackStrategy('author', 'exact_html_selector');
                return authorName;
            }
        }
        
        // ✅ Strategy 1: REEL author (h2 with specific class)
        const reelAuthorEl = postEl.locator('h2.html-h2 a[aria-label*="See owner profile"]').first();
        if (await reelAuthorEl.count() > 0) {
            const text = await reelAuthorEl.textContent();
            if (text && text.trim()) {
                const authorName = cleanTextForCSV(text.trim());
                console.log`      -> Author (reel): ${authorName}`;
                trackStrategy('author', 'reel_h2_profile_link');
                return authorName;
            }
        }
        
        // ✅ Strategy 2: Try profile.php link for reel
        const reelAuthorAlt = postEl.locator('h2 a[href*="/profile.php"]').first();
        if (await reelAuthorAlt.count() > 0) {
            const text = await reelAuthorAlt.textContent();
            if (text && text.trim()) {
                const authorName = cleanTextForCSV(text.trim());
                console.log`      -> Author (reel profile): ${authorName}`;
                trackStrategy('author', 'reel_profile_php');
                return authorName;
            }
        }
        
        // ✅ Strategy 3: Pattern "X is with Y at Location"
        const withContainer = postEl.locator('h3:has-text(" is with "), h2:has-text(" is with ")').first();
        
        if (await withContainer.count() > 0) {
            const authorLinks = await withContainer.locator('b a[role="link"]').all();
            const authorNames = [];
            
            for (const link of authorLinks) {
                const href = await link.getAttribute('href');
                if (href && !href.includes('/pages/') && !href.includes('Kota-') && !href.includes('Kabupaten-') && !href.match(/Indonesia-\d+/)) {
                    const name = await link.innerText().catch(() => '');
                    if (name && name.trim()) {
                        authorNames.push(cleanTextForCSV(name.trim()));
                    }
                }
            }
            
            if (authorNames.length > 0) {
                const authorName = authorNames.join(' with ');
                console.log`      -> Authors (is with): ${authorName}`;
                trackStrategy('author', 'is_with_pattern');
                return authorName;
            }
        }
        
        // ✅ Strategy 4: Fallback - any strong/bold link in header
        const fallbackAuthor = postEl.locator('h3 a strong, h2 a strong, h4 a strong').first();
        if (await fallbackAuthor.count() > 0) {
            const text = await fallbackAuthor.innerText();
            if (text && text.trim()) {
                const authorName = cleanTextForCSV(text.trim());
                console.log`      -> Author (fallback): ${authorName}`;
                trackStrategy('author', 'fallback_strong');
                return authorName;
            }
        }
        
        console.log("      -> Author: N/A");
        return "N/A";
        
    } catch (e) {
        console.warn`      ⚠️ Author extraction error: ${e.message.substring(0, 40)}`;
        return "N/A";
    }
}


/**
 * ✅ UPDATED: Extract Content - dengan support translated content
 */
async function extractContent(postEl, page) {  // ⬅️ TAMBAH parameter 'page'
    try {
        console.log("      -> Extracting content...");
        
        // ========== STEP 0: Check & handle translated content FIRST ==========
        const wasTranslated = await handleTranslatedContent(page, postEl);
        
        if (wasTranslated) {
            console.log("      -> Extracting from ORIGINAL (Indonesian) content...");
        }
        
        // ========== Strategy 0: AFTER TRANSLATION (Indonesian content) ==========
        if (wasTranslated) {
            const indonesianSelectors = [
                // ✅ Priority 1: EXACT dari HTML setelah klik "See original"
                'div[data-ad-rendering-role="story_message"] span[lang="id-ID"] div[dir="auto"]',
                'div[data-ad-comet-preview="message"] span[lang="id-ID"] div[dir="auto"]',
                // Priority 2: Broader
                'div[data-ad-rendering-role="story_message"] div[dir="auto"]',
                'span[lang="id-ID"] div[dir="auto"]',
            ];
            
            for (const selector of indonesianSelectors) {
                const contentDivs = await postEl.locator(selector).all();
                
                if (contentDivs.length > 0) {
                    const paragraphs = [];
                    
                    for (const div of contentDivs) {
                        const text = await div.textContent() || '';
                        if (text.trim()) {
                            paragraphs.push(text.trim());
                        }
                    }
                    
                    if (paragraphs.length > 0) {
                        const content = cleanTextForCSV(paragraphs.join(' '));
                        console.log(`      -> Text (Indonesian): ${content.substring(0, 50)}...`);
                        trackStrategy('content', 'indonesian_after_translation');
                        return content;
                    }
                }
            }
        }
        
        // ========== Strategy 1: EXACT from HTML (blockquote) ==========
        const exactContentSelectors = [
            'blockquote.html-blockquote div[dir="auto"][style*="text-align"]',
            'blockquote.html-blockquote span[dir="auto"] div[dir="auto"]',
        ];
        
        for (const selector of exactContentSelectors) {
            const contentDivs = await postEl.locator(selector).all();
            
            if (contentDivs.length > 0) {
                const paragraphs = [];
                
                for (const div of contentDivs) {
                    const text = await div.textContent() || '';
                    if (text.trim() && 
                        !text.includes('See more') && 
                        !text.includes('See original') &&
                        !text.includes('Translation preferences') &&
                        !text.includes('Rate this translation')) {
                        paragraphs.push(text.trim());
                    }
                }
                
                if (paragraphs.length > 0) {
                    const content = cleanTextForCSV(paragraphs.join(' '));
                    console.log(`      -> Text (exact): ${content.substring(0, 50)}...`);
                    trackStrategy('content', 'exact_html_selector_' + exactContentSelectors.indexOf(selector));
                    return content;
                }
            }
        }
        
        // ========== Strategy 2: REEL content text ==========
        const reelContentSelectors = [
            'div.xdj266r.x14z9mp.xat24cr.x1lziwak.xvue9z',
            'span.x193iq5w.xeuugli > div.xdj266r.x14z9mp'
        ];
        
        for (const selector of reelContentSelectors) {
            const reelTextEls = await postEl.locator(selector).all();
            
            if (reelTextEls.length > 0) {
                const paragraphs = [];
                
                for (const el of reelTextEls) {
                    const rawText = await el.textContent() || '';
                    if (rawText.trim()) {
                        paragraphs.push(rawText.trim());
                    }
                }
                
                if (paragraphs.length > 0) {
                    const fullText = paragraphs.join(' ');
                    const cleanedText = fullText
                        .replace(/#[\w]+\s*/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                        
                    if (cleanedText && cleanedText.length > 0) {
                        const content = cleanTextForCSV(cleanedText);
                        console.log(`      -> Text (reel): ${content.substring(0, 50)}...`);
                        trackStrategy('content', 'reel_selector_' + reelContentSelectors.indexOf(selector));
                        return content;
                    }
                }
            }
        }
        
        // ========== Strategy 3: Fallback ==========
        const fallbackSelectors = [
            'div[data-ad-preview="message"] span[dir="auto"]',
            'div[data-ad-comet-preview="message"] span',
        ];
        
        for (const selector of fallbackSelectors) {
            const textEl = await postEl.locator(selector).first();
            if (await textEl.count() > 0) {
                const rawText = await textEl.textContent() || '';
                const content = cleanTextForCSV(rawText);
                if (content) {
                    console.log(`      -> Text (fallback): ${content.substring(0, 50)}...`);
                    trackStrategy('content', 'fallback_selector_' + fallbackSelectors.indexOf(selector));
                    return content;
                }
            }
        }
        
        console.log("      -> Content: (empty)");
        return "";
        
    } catch (e) {
        console.warn(`      ⚠️ Content extraction error: ${e.message.substring(0, 40)}`);
        return "";
    }
}

/**
 * Extract Views (khusus untuk video posts)
 */
async function extractViews(postEl) {
    try {
        console.log("      -> Extracting views...");
        
        // ✅ PLACEHOLDER - Will be filled from HTML analysis
        
        return 0;
        
    } catch (e) {
        console.warn(`      ⚠️ Error extract views: ${e.message.substring(0, 40)}`);
        return 0;
    }
}


/**
 * ✅ NEW: Extract Views by opening video page in new tab
 */
async function extractVideoViewsFromPage(context, videoUrl) {
    if (!videoUrl || videoUrl === "N/A") return 0;
    
    let videoTab = null;
    
    try {
        console.log(`         -> Opening video page to extract views...`);
        
        // Open in new tab
        videoTab = await context.newPage();
        
        await videoTab.goto(videoUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        }).catch(() => null);
        
        await videoTab.waitForTimeout(3000);
        
        // Wait for video player to load
        await videoTab.waitForSelector('video, div[role="main"]', { timeout: 10000 }).catch(() => {});
        await videoTab.waitForTimeout(2000);
        
        // ========== EXTRACT VIEWS ==========
        const viewsSelectors = [
            // Primary selector dari HTML yang diberikan
            'span.html-span:has(span:has-text("views"))',
            'span._26fq:has-text("views")',
            'span:has(span:text-matches("\\d+[KkMm]?\\s*views"))',
            // Fallback selectors
            'span.x193iq5w:has-text("views")',
            'span:text-matches("\\d+[KkMm]?\\s*views")',
            'div:has-text("views")',
        ];
        
        for (const selector of viewsSelectors) {
            try {
                const viewSpans = await videoTab.locator(selector).all();
                
                for (const span of viewSpans) {
                    const text = await span.textContent();
                    
                    if (text && text.toLowerCase().includes('view')) {
                        // Match pattern: "38K views", "1.2M views", "500 views"
                        const match = text.match(/(\d+[\d,.]*(K|k|M|m|rb|Rb|jt|Jt)?)\s*views?/i);
                        
                        if (match) {
                            const count = parseEngagementCount(match[1]);
                            
                            if (count > 0) {
                                console.log(`         ✅ Views extracted: ${count} (${match[0]})`);
                                return count;
                            }
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        // Fallback: search all text content
        const allTexts = await videoTab.locator('span, div').allTextContents();
        for (const text of allTexts) {
            if (!text) continue;
            
            const match = text.match(/(\d+[\d,.]*(K|k|M|m|rb|Rb|jt|Jt)?)\s*views?/i);
            if (match) {
                const count = parseEngagementCount(match[1]);
                if (count > 0) {
                    console.log(`         ✅ Views extracted (fallback): ${count}`);
                    return count;
                }
            }
        }
        
        console.log(`         -> Views not found on video page`);
        return 0;
        
    } catch (error) {
        console.warn(`         ⚠️ Error extracting views from page: ${error.message.substring(0, 50)}`);
        return 0;
        
    } finally {
        // ALWAYS close tab
        if (videoTab && !videoTab.isClosed()) {
            await videoTab.close().catch(() => {});
            console.log(`         -> Video tab closed`);
        }
    }
}


/**
 * ✅ NEW: Extract Engagement from Reel Page in New Tab
 */
async function extractReelEngagementFromPage(context, reelUrl) {
    if (!reelUrl || reelUrl === "N/A") {
        return { reactions: 0, comments: 0, shares: 0 };
    }
    
    let reelTab = null;
    
    try {
        console.log(`         -> Opening reel page to extract engagement...`);
        
        // Open in new tab
        reelTab = await context.newPage();
        
        await reelTab.goto(reelUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        }).catch(() => null);
        
        await reelTab.waitForTimeout(3000);
        
        // Wait for reel player to load
        await reelTab.waitForSelector('video, div[role="main"]', { timeout: 10000 }).catch(() => {});
        await reelTab.waitForTimeout(2000);
        
        let reactions = 0, comments = 0, shares = 0;
        
        // ========== EXTRACT REACTIONS ==========
        const reactionSelectors = [
            // Primary: Exact match dari HTML
            'div[aria-label="Like"][role="button"] span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6.xlyipyv.xuxw1ft.x1j85h84',
            'div[aria-label="Like"][role="button"] span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6',
            // Fallback
            'div[aria-label="Like"] span.x1lliihq',
            'div[aria-label="Like"] span[dir="auto"]',
        ];
        
        for (const selector of reactionSelectors) {
            try {
                const reactionSpan = await reelTab.locator(selector).first();
                if (await reactionSpan.count() > 0) {
                    const text = await reactionSpan.textContent();
                    if (text && text.match(/\d/)) {
                        reactions = parseEngagementCount(text);
                        if (reactions > 0) {
                            console.log(`         ✅ Reactions extracted: ${reactions} (${text})`);
                            break;
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        // ========== EXTRACT COMMENTS ==========
        const commentSelectors = [
            // Primary: Exact match dari HTML
            'div[aria-label="Comment"][role="button"] span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6.xlyipyv.xuxw1ft.x1j85h84',
            'div[aria-expanded="false"][aria-label="Comment"] span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6',
            // Fallback
            'div[aria-label="Comment"] span.x1lliihq',
            'div[aria-label="Comment"] span[dir="auto"]',
        ];
        
        for (const selector of commentSelectors) {
            try {
                const commentSpan = await reelTab.locator(selector).first();
                if (await commentSpan.count() > 0) {
                    const text = await commentSpan.textContent();
                    if (text && text.match(/\d/)) {
                        comments = parseEngagementCount(text);
                        if (comments > 0) {
                            console.log(`         ✅ Comments extracted: ${comments} (${text})`);
                            break;
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        // ========== EXTRACT SHARES ==========
        const shareSelectors = [
            // Primary: Exact match dari HTML
            'div[aria-label="Share"][role="button"] span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6.xlyipyv.xuxw1ft.x1j85h84',
            'div[aria-label="Share"][role="button"] span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6',
            // Fallback
            'div[aria-label="Share"] span.x1lliihq',
            'div[aria-label="Share"] span[dir="auto"]',
        ];
        
        for (const selector of shareSelectors) {
            try {
                const shareSpan = await reelTab.locator(selector).first();
                if (await shareSpan.count() > 0) {
                    const text = await shareSpan.textContent();
                    if (text && text.match(/\d/)) {
                        shares = parseEngagementCount(text);
                        if (shares > 0) {
                            console.log(`         ✅ Shares extracted: ${shares} (${text})`);
                            break;
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        // If still no data, try broader search
        if (reactions === 0 && comments === 0 && shares === 0) {
            console.log(`         -> Trying broader search for engagement...`);
            
            const allButtons = await reelTab.locator('div[role="button"]').all();
            
            for (const button of allButtons) {
                try {
                    const ariaLabel = await button.getAttribute('aria-label');
                    
                    if (ariaLabel) {
                        const spans = await button.locator('span.x1lliihq').all();
                        
                        for (const span of spans) {
                            const text = await span.textContent();
                            if (text && text.match(/\d/)) {
                                const count = parseEngagementCount(text);
                                
                                if (count > 0) {
                                    if (ariaLabel.toLowerCase().includes('like') && reactions === 0) {
                                        reactions = count;
                                        console.log(`         ✅ Reactions found (broader): ${reactions}`);
                                    } else if (ariaLabel.toLowerCase().includes('comment') && comments === 0) {
                                        comments = count;
                                        console.log(`         ✅ Comments found (broader): ${comments}`);
                                    } else if (ariaLabel.toLowerCase().includes('share') && shares === 0) {
                                        shares = count;
                                        console.log(`         ✅ Shares found (broader): ${shares}`);
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    continue;
                }
            }
        }
        
        if (reactions === 0 && comments === 0 && shares === 0) {
            console.log(`         -> No engagement found on reel page`);
        }
        
        return { reactions, comments, shares };
        
    } catch (error) {
        console.warn(`         ⚠️ Error extracting engagement from reel: ${error.message.substring(0, 50)}`);
        return { reactions: 0, comments: 0, shares: 0 };
        
    } finally {
        // ALWAYS close tab
        if (reelTab && !reelTab.isClosed()) {
            await reelTab.close().catch(() => {});
            console.log(`         -> Reel tab closed`);
        }
    }
}


/**
 * ✅ ENHANCED: Extract Reactions with MULTIPLE REEL formats
 */
async function extractReactions(postEl, page, postIndex, screenshotOnFail = false) {
    try {
        console.log("      -> Extracting reactions...");
        
        // ✅ Strategy 0: EXACT from HTML (span with specific classes)
        const exactReactionSelectors = [
            'span.xt0b8zv.x135b78x', // EXACT from HTML: "1.5K"
            'span[aria-hidden="true"].x1kmio9f.x6ikm8r.x10wlt62.xlyipyv.x1exxlbk span.xt0b8zv.x135b78x',
        ];
        
        for (const selector of exactReactionSelectors) {
            const reactionSpan = postEl.locator(selector).first();
            if (await reactionSpan.count() > 0) {
                const text = await reactionSpan.textContent();
                if (text && text.match(/\d/)) {
                    const count = parseEngagementCount(text);
                    if (count > 0) {
                        console.log`      -> Reactions (exact): ${count} (${text})`;
                        trackStrategy('reactions', 'exact_html_selector_' + exactReactionSelectors.indexOf(selector));
                        return count;
                    }
                }
            }
        }
        
        // ✅ Strategy 1: Broader search for reaction count
        const broadReactionSelectors = [
            'div[aria-label*="reaction"] span.xt0b8zv',
            'span.x1kmio9f span.xt0b8zv',
        ];
        
        for (const selector of broadReactionSelectors) {
            const reactionSpan = postEl.locator(selector).first();
            if (await reactionSpan.count() > 0) {
                const text = await reactionSpan.textContent();
                if (text && text.match(/\d/)) {
                    const count = parseEngagementCount(text);
                    if (count > 0) {
                        console.log`      -> Reactions (broad): ${count}`;
                        trackStrategy('reactions', 'broad_selector_' + broadReactionSelectors.indexOf(selector));
                        return count;
                    }
                }
            }
        }
        
        console.log("      -> Reactions: 0");
        return 0;
        
    } catch (e) {
        console.warn`       ⚠️ Error extract reactions: ${e.message.substring(0, 40)}`;
        return 0;
    }
}

/**
 * ✅ ENHANCED: Extract Comments with MULTIPLE REEL formats
 */
async function extractComments(postEl, page, postIndex, screenshotOnFail = false) {
    try {
        console.log("      -> Extracting comments count...");
        
        // ✅ Strategy 0: EXACT from HTML
        const exactCommentSelectors = [
            'span.xkrqix3.x1sur9pj:has-text("comments")', // EXACT: "129 comments"
            'span.html-span.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x1hl2dhg.x16tdsg8.x1vvkbs.xkrqix3.x1sur9pj',
        ];
        
        for (const selector of exactCommentSelectors) {
            const commentSpans = await postEl.locator(selector).all();
            
            for (const span of commentSpans) {
                const text = await span.textContent();
                
                if (text && text.toLowerCase().includes('comment')) {
                    // Match "129 comments" or "1 comment"
                    const match = text.match(/(\d+[\d,.]*(K|k|M|m)?)\s*comment/i);
                    if (match) {
                        const count = parseEngagementCount(match[1]);
                        if (count >= 0) {
                            console.log`      -> Comments (exact): ${count} (${text})`;
                            trackStrategy('comments', 'exact_html_selector_' + exactCommentSelectors.indexOf(selector));
                            return count;
                        }
                    }
                }
            }
        }
        
        // ✅ Strategy 1: Fallback - role="button" with comment text
        const fallbackCommentSelectors = [
            'div[role="button"]:has-text("comment") span.x193iq5w',
        ];
        
        for (const selector of fallbackCommentSelectors) {
            const commentEl = postEl.locator(selector).first();
            if (await commentEl.count() > 0) {
                const text = await commentEl.textContent();
                if (text && text.toLowerCase().includes('comment')) {
                    const match = text.match(/(\d+[\d,.]*(K|k|M|m)?)\s*comment/i);
                    if (match) {
                        const count = parseEngagementCount(match[1]);
                        if (count >= 0) {
                            console.log`      -> Comments (fallback): ${count}`;
                            trackStrategy('comments', 'fallback_selector_' + fallbackCommentSelectors.indexOf(selector));
                            return count;
                        }
                    }
                }
            }
        }
        
        console.log("      -> Comments: 0");
        return 0;
        
    } catch (e) {
        console.warn`       ⚠️ Error extract comments: ${e.message.substring(0, 40)}`;
        return 0;
    }
}

/**
 * ✅ ENHANCED: Extract Shares with MULTIPLE REEL formats
 */
async function extractShares(postEl, page, postIndex, screenshotOnFail = false) {
    try {
        console.log("      -> Extracting shares...");
        
        // ✅ Strategy 0: EXACT from HTML
        const exactShareSelectors = [
            'span.xkrqix3.x1sur9pj:has-text("shares")', // EXACT: "120 shares"
            'span.html-span.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x1hl2dhg.x16tdsg8.x1vvkbs.xkrqix3.x1sur9pj',
        ];
        
        for (const selector of exactShareSelectors) {
            const shareSpans = await postEl.locator(selector).all();
            
            for (const span of shareSpans) {
                const text = await span.textContent();
                
                if (text && text.toLowerCase().includes('share')) {
                    // Match "120 shares" or "1 share"
                    const match = text.match(/(\d+[\d,.]*(K|k|M|m)?)\s*share/i);
                    if (match) {
                        const count = parseEngagementCount(match[1]);
                        if (count >= 0) {
                            console.log`      -> Shares (exact): ${count} (${text})`;
                            trackStrategy('shares', 'exact_html_selector_' + exactShareSelectors.indexOf(selector));
                            return count;
                        }
                    }
                }
            }
        }
        
        // ✅ Strategy 1: Fallback - role="button" with share text
        const fallbackShareSelectors = [
            'div[role="button"]:has-text("share") span.x193iq5w',
        ];
        
        for (const selector of fallbackShareSelectors) {
            const shareEl = postEl.locator(selector).first();
            if (await shareEl.count() > 0) {
                const text = await shareEl.textContent();
                if (text && text.toLowerCase().includes('share')) {
                    const match = text.match(/(\d+[\d,.]*(K|k|M|m)?)\s*share/i);
                    if (match) {
                        const count = parseEngagementCount(match[1]);
                        if (count >= 0) {
                            console.log`      -> Shares (fallback): ${count}`;
                            trackStrategy('shares', 'fallback_selector_' + fallbackShareSelectors.indexOf(selector));
                            return count;
                        }
                    }
                }
            }
        }
        
        console.log("      -> Shares: 0");
        return 0;
        
    } catch (e) {
        console.warn`       ⚠️ Error extract shares: ${e.message.substring(0, 40)}`;
        return 0;
    }
}


/**
 * ✅ ENHANCED: Quick extract URL dengan support untuk external links
 * Return: { url, timestampLinkEl } atau null
 */
async function quickExtractUrl(postEl) {
    try {
        let postUrl = null;
        let timestampLinkEl = null;
        

        // ✅ ADD THIS at the BEGINNING of Strategy 1:
        const priorityLinkSelectors = [
            'a[role="link"][attributionsrc]', // ✅ NEW - highest priority from HTML
        ];

        for (const selector of priorityLinkSelectors) {
            timestampLinkEl = await postEl.locator(selector).first();
            if (await timestampLinkEl.count() > 0) {
                const href = await timestampLinkEl.getAttribute('href');
                if (href && (href.includes('/posts/') || href.includes('/videos/') || href.includes('/photo') || href.includes('/reel/'))) {
                    postUrl = cleanPostUrl(new URL(href, 'https://www.facebook.com').href);
                    console.log`         ✅ Strategy 1 (priority): Attribution link found`;
                    trackStrategy('url', 'attribution_link_priority');
                    break;
                }
            }
        }

        // ========== ✅ NEW STRATEGY 00: attributionsrc links (HIGHEST PRIORITY) ==========
        const attributionLink = await postEl.locator('a[role="link"][attributionsrc]').first();
        if (await attributionLink.count() > 0) {
            const href = await attributionLink.getAttribute('href');
            if (href && (href.includes('/posts/') || href.includes('/photo') || href.includes('/videos/'))) {
                const fullUrl = href.startsWith('http') ? href : new URL(href, 'https://www.facebook.com').href;
                postUrl = cleanPostUrl(fullUrl);
                timestampLinkEl = attributionLink;
                console.log(`         ✅ Strategy 00: Attribution link found`);
                trackStrategy('url', 'attribution_link'); // ✅ TAMBAH
                return { url: postUrl, timestampLinkEl };
            }
        }
        
        // ========== STRATEGY 0: Share links (NEW FORMAT) ==========
        const shareLinks = await postEl.locator('a[href*="/share/v/"], a[href*="/share/p/"], a[href*="/share/r/"]').all();
        for (const link of shareLinks) {
            const href = await link.getAttribute('href');
            if (href && (href.includes('/share/v/') || href.includes('/share/p/') || href.includes('/share/r/'))) {
                const fullUrl = href.startsWith('http') ? href : new URL(href, 'https://www.facebook.com').href;
                postUrl = cleanPostUrl(fullUrl);
                timestampLinkEl = link;
                console.log(`         ✅ Strategy 0: Share link found`);
                trackStrategy('url', 'share_link_v_p_r'); // ✅ TAMBAH
                break;
            }
        }
        
        // ========== STRATEGY 1: Traditional Facebook post links ==========
        if (!postUrl) {
            const linkSelectors = [
                'a[aria-labelledby][href*="__cft__"]',
                'a[href*="__cft__"]:has(span:text-matches("\\d{1,2}\\s+\\w+"))',
                'a[href*="/posts/"], a[href*="/videos/"], a[href*="/photo"], a[href*="/watch/"], a[href*="/reel/"]',
                'div[role="article"] h3 ~ div a[href], div[role="article"] h2 ~ div a[href]'
            ];
            
            for (const selector of linkSelectors) {
                timestampLinkEl = await postEl.locator(selector).first();
                if (await timestampLinkEl.count() > 0) {
                    const href = await timestampLinkEl.getAttribute('href');
                    if (href && (href.includes('/posts/') || href.includes('/videos/') || href.includes('/photo') || href.includes('/watch/') || href.includes('/reel/'))) {
                        postUrl = cleanPostUrl(new URL(href, 'https://www.facebook.com').href);
                        console.log(`         ✅ Strategy 1: Traditional FB link found`);
                        trackStrategy('url', 'traditional_fb_selector_' + linkSelectors.indexOf(selector)); // ✅ TAMBAH
                        break;
                    }
                }
            }
        }
                
        // ========== STRATEGY 2: Alternative Facebook link formats ==========
        if (!postUrl) {
            const altLinkSelectors = [
                'a[href*="/share/v/"]', 'a[href*="/share/p/"]', 'a[href*="/reel/"]',
                'a[href*="/permalink/"]', 'a[href*="story_fbid"]', 'a[href*="/photo.php"]',
                'a[href*="fbid="]', 'a[href^="/watch/"]', 'a[href*="/groups/"][href*="/posts/"]'
            ];
            
            for (const selector of altLinkSelectors) {
                const link = await postEl.locator(selector).first();
                if (await link.count() > 0) {
                    const href = await link.getAttribute('href');
                    if (href) {
                        postUrl = cleanPostUrl(new URL(href, 'https://www.facebook.com').href);
                        timestampLinkEl = link;
                        console.log(`         ✅ Strategy 2: Alternative FB link found`);
                        trackStrategy('url', 'alternative_selector_' + altLinkSelectors.indexOf(selector)); // ✅ TAMBAH
                        break;
                    }
                }
            }
        }

        // ========== STRATEGY 3: External links (NEWS ARTICLES, etc) ==========
        if (!postUrl) {
            console.log(`         -> Strategy 3: Looking for external links...`);
            
            const externalLinkSelectors = [
                // Links with attributionsrc (Facebook tracking untuk external links)
                'a[attributionsrc][target="_blank"]:not([href*="facebook.com"])',
                // Links dengan href langsung ke external domain
                'a[href^="http"]:not([href*="facebook.com"]):not([href*="fbcdn.net"]):not([href*="instagram.com"])[target="_blank"]',
                // Links dalam article preview/card
                'div.x1n2onr6 a[href^="http"]:not([href*="facebook.com"])',
                'div[role="article"] a[href^="http"]:not([href*="facebook.com"])',
                // Broader search for any external link
                'a[href^="https://"]:not([href*="facebook.com"]):not([href*="fbcdn"])',
            ];
            
            for (const selector of externalLinkSelectors) {
                const link = await postEl.locator(selector).first();
                if (await link.count() > 0) {
                    const href = await link.getAttribute('href');
                    
                    // Validate it's a real external URL
                    if (href && 
                        href.startsWith('http') && 
                        !href.includes('facebook.com') && 
                        !href.includes('fbcdn.net') &&
                        !href.includes('fb.com') &&
                        !href.includes('instagram.com')) {
                        
                        // Clean fbclid tracking parameter
                        postUrl = href.split('?fbclid=')[0].split('&fbclid=')[0];
                        timestampLinkEl = link;
                        console.log(`         ✅ Strategy 3: External link found - ${postUrl.substring(0, 70)}...`);
                        trackStrategy('url', 'external_link_selector_' + externalLinkSelectors.indexOf(selector)); // ✅ TAMBAH
                        break;
                    }
                }
            }
        }

        // ========== STRATEGY 4: Super comprehensive search ==========
        if (!postUrl) {
            console.log(`         -> Strategy 4: Comprehensive link search...`);
            const allLinks = await postEl.locator('a[href]').all();
            
            // First pass: Look for Facebook post links
            for (const link of allLinks) {
                const href = await link.getAttribute('href');
                
                if (href && 
                    (href.includes('/share/') || 
                    href.includes('/posts/') || 
                    href.includes('/videos/') || 
                    href.includes('/photo') ||
                    href.includes('/watch/') ||
                    href.includes('/reel/') ||
                    href.includes('story_fbid'))) {
                    
                    const fullUrl = href.startsWith('http') ? href : new URL(href, 'https://www.facebook.com').href;
                    postUrl = cleanPostUrl(fullUrl);
                    timestampLinkEl = link;
                    console.log(`         ✅ Strategy 4a: FB link found - ${postUrl.substring(0, 70)}...`);
                    trackStrategy('url', 'comprehensive_fb_link'); // ✅ TAMBAH
                    break;
                }
            }
            
            // Second pass: If still no URL, look for ANY external links
            if (!postUrl) {
                for (const link of allLinks) {
                    const href = await link.getAttribute('href');
                    
                    if (href && 
                        href.startsWith('http') && 
                        !href.includes('facebook.com') && 
                        !href.includes('fbcdn.net') &&
                        !href.includes('fb.com')) {
                        
                        // Skip URL shorteners
                        const skipDomains = ['bit.ly', 't.co', 'goo.gl', 'ow.ly', 'tinyurl.com'];
                        try {
                            const urlObj = new URL(href);
                            const domain = urlObj.hostname.replace('www.', '');
                            
                            if (!skipDomains.some(skip => domain.includes(skip))) {
                                postUrl = href.split('?fbclid=')[0].split('&fbclid=')[0];
                                timestampLinkEl = link;
                                console.log(`         ✅ Strategy 4b: External link found - ${postUrl.substring(0, 70)}...`);
                                trackStrategy('url', 'comprehensive_external_link'); // ✅ TAMBAH
                                break;
                            }
                        } catch (urlError) {
                            continue;
                        }
                    }
                }
            }
        }
        
        // ========== VALIDATION ==========
        if (!postUrl || postUrl === '#' || postUrl.includes('undefined')) {
            console.log(`         ❌ All strategies failed - no valid URL found`);
            return null;
        }
        
        return { url: postUrl, timestampLinkEl };
        
    } catch (e) {
        console.warn(`         ⚠️ quickExtractUrl error: ${e.message.substring(0, 50)}`);
        return null;
    }
}


/**
 * ✅ FIXED: Extract Timestamp - Combined Best from Both Versions
 */
async function extractTimestamp(postEl, timestampLinkEl, page) {
    try {
        console.log("         -> Starting ENHANCED timestamp extraction...");
        
        // ✅ NEW: RESET MOUSE POSITION FIRST (Critical!)
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        
        // ========== STRATEGY 0: Find Better Link (SIMPLIFIED - dari versi lama) ==========
        console.log("         -> Strategy 0: Looking for better timestamp link...");
        
        let linkToHover = timestampLinkEl;
        
        // ✅ GUNAKAN VERSI LAMA: Lebih simple & reliable
        const betterLinkSelectors = [
            'a[role="link"][attributionsrc]',
            'span[aria-labelledby] a[role="link"]',
            'a[href*="/posts/"][role="link"]',
            'a[href*="/photo"][role="link"]',
            'a[href*="/videos/"][role="link"]',
        ];
        
        for (const selector of betterLinkSelectors) {
            const link = postEl.locator(selector).first();
            if (await link.count() > 0) {
                linkToHover = link;
                console.log(`         -> Found better link: ${selector.substring(0, 40)}...`);
                break; // ✅ LANGSUNG break, jangan check aria-label dulu
            }
        }

        // ========== STRATEGY F: VIDEO/REEL TIMESTAMP (FIXED - SKIP COMMENTS!) ==========
        console.log("         -> Strategy F: Video/Reel timestamp extraction");

        try {
            // ✅ KUNCI: Cari timestamp HANYA di bagian ATAS post (sebelum comments)
            // Bukan di seluruh postEl yang termasuk comment section!
            
            // Step 1: Find post header container (exclude comments)
            const postHeaderSelectors = [
                // Try to find header/top section only
                'div[class*="x1yc453h"]', // Common header wrapper
                'div.x1n2onr6.x1ja2u2z', // Another header pattern
            ];
            
            let postHeader = postEl;
            
            // Try to narrow down to just header section
            for (const selector of postHeaderSelectors) {
                const header = postEl.locator(selector).first();
                if (await header.count() > 0) {
                    postHeader = header;
                    console.log(`         -> Narrowed to post header: ${selector.substring(0, 30)}`);
                    break;
                }
            }
            
            // Step 2: Cari text timestamp relatif (20m, 2h, 3d, dll) - HANYA DI HEADER!
            const relativeTimestampSelectors = [
                'a[role="link"].x1i10hfl.xkrqix3.x1sur9pj.xi81zsa.x1s688f',
                'span.x1i10hfl.xkrqix3.x1sur9pj.xi81zsa.x1s688f',
                'a[role="link"]:not([aria-label])',
            ];
            
            for (const selector of relativeTimestampSelectors) {
                // ⭐ KEY CHANGE: Search in postHeader (not postEl!)
                const timestampLinks = await postHeader.locator(selector).all();
                
                for (const link of timestampLinks) {
                    // ✅ CHECK 1: Get surrounding context to avoid comment timestamps
                    const parentText = await link.evaluate(el => {
                        const parent = el.closest('div[role="article"]') || el.parentElement?.parentElement;
                        return parent ? parent.textContent.toLowerCase() : '';
                    }).catch(() => '');
                    
                    // ✅ CHECK 2: Skip if this is inside comment section
                    const isInCommentSection = 
                        parentText.includes('view more comments') ||
                        parentText.includes('write a comment') ||
                        parentText.includes('view all') && parentText.includes('replies') ||
                        parentText.includes('like') && parentText.includes('reply'); // comment actions
                    
                    if (isInCommentSection) {
                        console.log(`         -> Skipped: timestamp in comment section`);
                        continue;
                    }
                    
                    const text = await link.textContent().catch(() => '');
                    
                    // ✅ CHECK 3: Match relative timestamp pattern
                    const relativePattern = /^\d+[mhdw]$/i;
                    
                    if (text && text.trim().match(relativePattern)) {
                        console.log(`         -> Found relative timestamp: "${text.trim()}"`);
                        
                        // ✅ CHECK 4: Verify this is near author name (strong signal it's post timestamp)
                        const nearbyText = await link.evaluate(el => {
                            const container = el.closest('div');
                            return container ? container.textContent : '';
                        }).catch(() => '');
                        
                        // If nearby text has author-like content, this is likely correct
                        const hasAuthorNearby = 
                            nearbyText.includes('Kang Dedi') || 
                            nearbyText.includes('·') || // Separator common in post headers
                            nearbyText.includes('Follow') ||
                            nearbyText.includes('Public');
                        
                        if (!hasAuthorNearby) {
                            console.log(`         -> Skipped: no author context nearby`);
                            continue;
                        }
                        
                        console.log(`         -> ✅ Validated: This is post timestamp (not comment)`);
                        
                        // Scroll & hover
                        await link.scrollIntoViewIfNeeded().catch(() => {});
                        await page.waitForTimeout(800);
                        
                        const box = await link.boundingBox().catch(() => null);
                        if (box) {
                            const x = box.x + box.width / 2;
                            const y = box.y + box.height / 2;
                            await page.mouse.move(x, y, { steps: 5 });
                            console.log(`         -> Mouse moved to (${Math.round(x)}, ${Math.round(y)})`);
                        }
                        
                        await page.waitForTimeout(3500);
                        
                        // Check tooltip
                        const tooltipSelector = 'div[role="tooltip"] span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x1xmvt09.x1nxh6w3.x1sibtaa.xo1l8bm.xzsf02u';
                        const tooltip = page.locator(tooltipSelector).first();
                        
                        if (await tooltip.count() > 0) {
                            const tooltipText = await tooltip.textContent();
                            if (tooltipText && tooltipText.match(/\d{4}/) && tooltipText.length > 10) {
                                console.log(`         ✅ Strategy F SUCCESS: ${tooltipText}`);
                                await page.mouse.move(0, 0).catch(() => {});
                                trackStrategy('timestamp', 'video_reel_relative_timestamp');
                                return cleanTextForCSV(tooltipText);
                            }
                        }
                        
                        // Fallback: any visible tooltip
                        const anyTooltip = page.locator('div[role="tooltip"]:visible span').first();
                        if (await anyTooltip.count() > 0) {
                            const text = await anyTooltip.textContent();
                            if (text && text.match(/\d{4}/) && text.length > 10) {
                                console.log(`         ✅ Strategy F SUCCESS (fallback): ${text}`);
                                await page.mouse.move(0, 0).catch(() => {});
                                trackStrategy('timestamp', 'video_reel_relative_timestamp_fallback');
                                return cleanTextForCSV(text);
                            }
                        }
                    }
                }
            }
            
            await page.mouse.move(0, 0).catch(() => {});
            console.log("         -> Strategy F: Not a video/reel or failed");
            
        } catch (e) {
            console.log(`         -> Strategy F failed: ${e.message.substring(0, 30)}`);
        }
        
        // ========== STRATEGY A: HOVER METHOD (ENHANCED) ==========
        console.log("         -> Strategy A: Hover to timestamp link");
        
        try {
            // ✅ CRITICAL: LOCK SCROLL FIRST!
            await page.evaluate(() => {
                window._savedScrollY = window.scrollY;
                document.body.style.overflow = 'hidden';
                document.documentElement.style.overflow = 'hidden';
            });
            
            console.log("         -> Scroll locked");
            
            // ✅ Wait for element
            await linkToHover.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
            
            // ✅ Scroll dengan offset center
            await linkToHover.evaluate(el => {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            });
            await page.waitForTimeout(1200);
            
            // ✅ Get FRESH position
            let box = await linkToHover.boundingBox().catch(() => null);
            
            if (!box) {
                throw new Error("Cannot get bounding box");
            }
            
            let x = box.x + box.width / 2;
            let y = box.y + box.height / 2;
            
            console.log(`         -> Initial position: (${Math.round(x)}, ${Math.round(y)})`);
            
            // ✅ SLOW MOVEMENT
            await page.mouse.move(x, y, { steps: 10 });
            await page.waitForTimeout(500);
            
            // ✅ VERIFY position didn't change
            const boxAfterMove = await linkToHover.boundingBox().catch(() => null);
            
            if (boxAfterMove) {
                const newX = boxAfterMove.x + boxAfterMove.width / 2;
                const newY = boxAfterMove.y + boxAfterMove.height / 2;
                
                const deltaX = Math.abs(newX - x);
                const deltaY = Math.abs(newY - y);
                
                if (deltaX > 50 || deltaY > 50) {
                    console.log(`         ⚠️ Position changed! Re-hovering to (${Math.round(newX)}, ${Math.round(newY)})`);
                    await page.mouse.move(newX, newY, { steps: 5 });
                    await page.waitForTimeout(500);
                } else {
                    console.log(`         ✓ Position stable (Δ${Math.round(deltaX)}, Δ${Math.round(deltaY)})`);
                }
            }
            
            // ✅ Wait for tooltip
            await page.waitForTimeout(4000);
            
            // Check tooltip
            const tooltipSelector = 'div[role="tooltip"] span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x1xmvt09.x1nxh6w3.x1sibtaa.xo1l8bm.xzsf02u';
            const tooltip = page.locator(tooltipSelector).first();
            
            if (await tooltip.count() > 0) {
                const tooltipText = await tooltip.textContent();
                if (tooltipText && tooltipText.match(/\d{4}/) && tooltipText.length > 10) {
                    console.log(`         ✅ Strategy A SUCCESS: ${tooltipText}`);
                    
                    // Unlock scroll
                    await page.evaluate(() => {
                        document.body.style.overflow = '';
                        document.documentElement.style.overflow = '';
                    });
                    
                    await page.mouse.move(0, 0);
                    trackStrategy('timestamp', 'tooltip_exact_selector');
                    return cleanTextForCSV(tooltipText);
                }
            }
            
            // Fallback: any visible tooltip
            const anyTooltip = page.locator('div[role="tooltip"]:visible span').first();
            if (await anyTooltip.count() > 0) {
                const text = await anyTooltip.textContent();
                if (text && text.match(/\d{4}/) && text.length > 10) {
                    console.log(`         ✅ Strategy A2 SUCCESS: ${text}`);
                    
                    // Unlock scroll
                    await page.evaluate(() => {
                        document.body.style.overflow = '';
                        document.documentElement.style.overflow = '';
                    });
                    
                    await page.mouse.move(0, 0);
                    trackStrategy('timestamp', 'tooltip_any_visible');
                    return cleanTextForCSV(text);
                }
            }
            
            await page.mouse.move(0, 0);
            console.log("         -> Strategy A: No tooltip appeared");
            
        } catch (hoverError) {
            console.log(`         -> Hover failed: ${hoverError.message.substring(0, 30)}`);
            await page.mouse.move(0, 0);
        } finally {
            // ✅ ALWAYS UNLOCK (even on error)
            await page.evaluate(() => {
                document.body.style.overflow = '';
                document.documentElement.style.overflow = '';
            }).catch(() => {});
        }
        
        // ========== STRATEGY B: aria-labelledby Lookup ==========
        console.log("         -> Strategy B: aria-labelledby lookup");
        
        try {
            const spanWithAria = postEl.locator('span[aria-labelledby]').first();
            if (await spanWithAria.count() > 0) {
                const ariaId = await spanWithAria.getAttribute('aria-labelledby');
                if (ariaId) {
                    const labelEl = page.locator(`[id="${ariaId}"]`).first(); // ✅ FIXED syntax
                    if (await labelEl.count() > 0) {
                        const labelText = await labelEl.textContent();
                        if (labelText && labelText.match(/\d{4}/)) {
                            console.log(`         ✅ Strategy B SUCCESS: ${labelText}`);
                            trackStrategy('timestamp', 'aria_labelledby');
                            return cleanTextForCSV(labelText);
                        }
                    }
                }
            }
        } catch (e) {
            console.log(`         -> Strategy B failed: ${e.message.substring(0, 30)}`);
        }
        
        // ========== STRATEGY C: Hover to Date-Like Elements ==========
        console.log("         -> Strategy C: Hover to date-like elements");
        
        const datePatterns = [
            'span:text-matches("\\d+ (minute|hour|day|week|month|year)")',
            'span:text-matches("(Mon|Tue|Wed|Thu|Fri|Sat|Sun)")',
            'a[role="link"]:has(span[style*="display: flex"])',
        ];
        
        for (const pattern of datePatterns) {
            try {
                const dateEl = postEl.locator(pattern).first();
                if (await dateEl.count() > 0) {
                    await dateEl.scrollIntoViewIfNeeded().catch(() => {});
                    await page.waitForTimeout(500);
                    
                    const box = await dateEl.boundingBox().catch(() => null);
                    if (box) {
                        const x = box.x + box.width / 2;
                        const y = box.y + box.height / 2;
                        await page.mouse.move(x, y, { steps: 5 });
                        await page.waitForTimeout(3000); // ✅ 3000ms seperti versi lama
                        
                        const tooltip = page.locator('div[role="tooltip"] span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x1xmvt09.x1nxh6w3.x1sibtaa.xo1l8bm.xzsf02u').first();
                        if (await tooltip.count() > 0) {
                            const text = await tooltip.textContent();
                            if (text && text.match(/\d{4}/)) {
                                console.log(`         ✅ Strategy C SUCCESS: ${text}`);
                                await page.mouse.move(0, 0).catch(() => {});
                                trackStrategy('timestamp', 'hover_date_element_' + datePatterns.indexOf(pattern));
                                return cleanTextForCSV(text);
                            }
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        await page.mouse.move(0, 0).catch(() => {});
        console.log("         -> Strategy C: Failed");
        
        // ========== STRATEGY D: DOM Text Search ==========
        console.log("         -> Strategy D: DOM text search");
        
        const datePatterns2 = [
            /(\w+\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2})/i,
            /(\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s+at\s+\d{1,2}:\d{2})/i,
            /(\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2})/i,
            /(\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i,
        ];
        
        const allTexts = await postEl.locator('span, div, time, abbr').allTextContents();
        
        for (const text of allTexts) {
            for (const pattern of datePatterns2) {
                const match = text.match(pattern);
                if (match) {
                    console.log(`         ✅ Strategy D SUCCESS: ${match[0]}`);
                    trackStrategy('timestamp', 'dom_text_pattern_' + datePatterns2.indexOf(pattern));
                    return cleanTextForCSV(match[0]);
                }
            }
        }
        
        console.log("         -> Strategy D: Failed");
        
        // ========== STRATEGY E: TIME Element ==========
        console.log("         -> Strategy E: TIME element");
        
        const timeEl = postEl.locator('time, abbr[data-utime]').first();
        if (await timeEl.count() > 0) {
            const datetime = await timeEl.getAttribute('datetime') || await timeEl.textContent();
            if (datetime && datetime.match(/\d{4}/)) {
                console.log(`         ✅ Strategy E SUCCESS: ${datetime}`);
                trackStrategy('timestamp', 'time_element');
                return cleanTextForCSV(datetime);
            }
        }
        
        console.log("         -> Strategy E: Failed");
        console.log("         ❌ ALL STRATEGIES FAILED");
        return "N/A";
        
    } catch (e) {
        console.warn(`         ⚠️ Error: ${e.message.substring(0, 60)}`);
        return "N/A";
    }
}

/**
 * ✅ NEW: Extract Timestamp WITH RETRY (wrapper)
 */
async function extractTimestampWithRetry(postEl, timestampLinkEl, page, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`         -> Timestamp extraction (attempt ${attempt}/${maxRetries})...`);
            
            const result = await extractTimestamp(postEl, timestampLinkEl, page);
            
            // ✅ SUCCESS
            if (result && result !== "N/A" && result.length > 5) {
                if (attempt > 1) {
                    console.log(`         ✅ Success on attempt ${attempt}!`);
                }
                return result;
            }
            
            // ✅ RETRY
            if (attempt < maxRetries) {
                console.log(`         ⚠️ Got "${result}" - retrying...`);
                await page.waitForTimeout(2000);
                
                // Re-hover
                if (timestampLinkEl) {
                    try {
                        await page.mouse.move(0, 0);
                        await page.waitForTimeout(300);
                        await timestampLinkEl.scrollIntoViewIfNeeded().catch(() => {});
                        await page.waitForTimeout(500);
                        
                        const box = await timestampLinkEl.boundingBox().catch(() => null);
                        if (box) {
                            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                            await page.waitForTimeout(1000);
                        }
                    } catch (e) {}
                }
            }
            
        } catch (error) {
            console.log(`         ⚠️ Attempt ${attempt} error: ${error.message.substring(0, 40)}`);
            if (attempt < maxRetries) {
                await page.waitForTimeout(2000);
            }
        }
    }
    
    console.log(`         ❌ All ${maxRetries} attempts failed`);
    return "N/A";
}


/**
 * ✅ FIXED: Extract Share URL - PROTECTED CLIPBOARD
 * Keep existing Share button mechanism but protect from user clipboard interference
 */
async function extractShareUrl(page, postEl) {
    let shareUrl = "N/A";
    let originalClipboard = null;
    
    try {
        // ========== STEP 0: Save original clipboard ==========
        try {
            originalClipboard = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
            if (originalClipboard) {
                console.log(`         ℹ️  Original clipboard saved (will be restored)`);
            }
        } catch (e) {
            console.log(`         -> Cannot access clipboard initially`);
        }
        
        // ========== STEP 1: Find Actions button (Titik 3 ...) ==========
        const actionsButtonSelectors = [
            // ✅ Priority 1: EXACT from USER HTML
            'div[aria-expanded="false"][aria-haspopup="menu"][aria-label="Actions for this post"][role="button"]',
            // Priority 2: Broader search (kalau aria-expanded sudah true)
            'div[aria-haspopup="menu"][aria-label="Actions for this post"][role="button"]',
            // Priority 3: SVG-based (titik 3 icon)
            'div[role="button"][aria-haspopup="menu"]:has(svg[viewBox="0 0 20 20"])',
            // Fallback
            'div[aria-label*="Actions"][role="button"]',
        ];
        
        let actionsButton = null;
        
        for (const selector of actionsButtonSelectors) {
            const btn = postEl.locator(selector).first();
            if (await btn.count() > 0) {
                actionsButton = btn;
                console.log(`         -> Found Actions button (titik 3)`);
                break;
            }
        }
        
        if (!actionsButton) {
            console.log(`         -> Actions button not found`);
            return "N/A";
        }
        
        await actionsButton.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
        
        // ========== STEP 2: Click Actions button with retry ==========
        let clickSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(`         -> Clicking Actions button (attempt ${attempt}/3)...`);
                await actionsButton.click({ timeout: 5000 });
                console.log(`         -> Actions button clicked`);
                clickSuccess = true;
                break;
            } catch (e) {
                console.log(`         -> Click attempt ${attempt} failed: ${e.message.substring(0, 30)}`);
                if (attempt < 3) {
                    await page.waitForTimeout(1000);
                }
            }
        }
        
        if (!clickSuccess) {
            console.log(`         -> Failed to click Actions button after 3 attempts`);
            return "N/A";
        }
        
        // ✅ WAIT LONGER untuk menu muncul
        await page.waitForTimeout(3500);
        
        // ========== STEP 3: Find Copy link menuitem ==========
        console.log(`         -> Looking for Copy link menuitem...`);
        
        const copyLinkSelectors = [
            // ✅ Priority 1: EXACT from USER HTML (role="menuitem")
            'div[role="menuitem"]:has(span:has-text("Copy link"))',
            // Priority 2: More specific with classes
            'div.x1i10hfl.xjbqb8w.x1ejq31n[role="menuitem"]:has(span.x193iq5w.xeuugli:has-text("Copy link"))',
            // Priority 3: Icon-based
            'div[role="menuitem"]:has(i[style*="lTFsj4P7ja8.png"])',
            // Fallback (span only)
            'span.x193iq5w.xeuugli:has-text("Copy link")',
        ];
        
        let copyLinkButton = null;
        let usedSelector = null;
        
        for (const selector of copyLinkSelectors) {
            try {
                const btn = page.locator(selector).first();
                await btn.waitFor({ state: 'visible', timeout: 5000 });
                
                if (await btn.count() > 0) {
                    copyLinkButton = btn;
                    usedSelector = selector;
                    console.log(`         ✓ Found Copy link with: ${selector.substring(0, 60)}...`);
                    break;
                }
            } catch (e) {
                console.log(`         -> Selector failed: ${selector.substring(0, 40)}...`);
                continue;
            }
        }
        
        if (!copyLinkButton) {
            console.log(`         -> Copy link button not found`);
            
            // ✅ DEBUG: Save screenshot of menu
            if (CONFIG.DEBUG_MODE) {
                await page.screenshot({ path: `debug_share_menu_${Date.now()}.png` }).catch(() => {});
                console.log(`         📸 Share menu screenshot saved`);
            }
            
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
            return "N/A";
        }
        
        // ========== STEP 4: Clear clipboard before click ==========
        try {
            await page.evaluate(() => navigator.clipboard.writeText(''));
            console.log(`         -> Clipboard cleared before copy`);
        } catch (e) {
            console.log(`         -> Cannot clear clipboard`);
        }
        
        await page.waitForTimeout(300);
        
        // ========== STEP 5: Click Copy link with retry ==========
        let copyClickSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(`         -> Clicking Copy link (attempt ${attempt}/3)...`);
                
                // Scroll into view first
                await copyLinkButton.scrollIntoViewIfNeeded().catch(() => {});
                await page.waitForTimeout(300);
                
                await copyLinkButton.click({ timeout: 5000 });
                console.log(`         ✅ Copy link clicked`);
                copyClickSuccess = true;
                break;
            } catch (e) {
                console.log(`         -> Click attempt ${attempt} failed`);
                
                // Try force click on 2nd attempt
                if (attempt === 2) {
                    try {
                        console.log(`         -> Trying force click...`);
                        await copyLinkButton.click({ force: true, timeout: 5000 });
                        console.log(`         ✅ Force click successful`);
                        copyClickSuccess = true;
                        break;
                    } catch (e2) {
                        console.log(`         -> Force click also failed`);
                    }
                }
                
                if (attempt < 3) {
                    await page.waitForTimeout(1500);
                }
            }
        }
        
        if (!copyClickSuccess) {
            console.log(`         -> Failed to click Copy link`);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
            return "N/A";
        }
        
        // ========== STEP 6: Read clipboard IMMEDIATELY with multiple attempts ==========
        let clipboardAttempts = 0;
        const maxClipboardAttempts = 5;
        
        while (clipboardAttempts < maxClipboardAttempts) {
            await page.waitForTimeout(400); // Wait for Facebook to write
            
            try {
                const clipboardContent = await page.evaluate(() => navigator.clipboard.readText());
                
                // Validate it's a Facebook URL
                if (clipboardContent && 
                    (clipboardContent.includes('facebook.com') || 
                     clipboardContent.includes('fb.watch') || 
                     clipboardContent.includes('fb.me'))) {
                    shareUrl = clipboardContent;
                    console.log(`         ✅ Got Facebook URL from clipboard (attempt ${clipboardAttempts + 1})`);
                    trackStrategy('shareUrl', 'clipboard_copy_link_button'); // ✅ TAMBAH
                    break;
                } else {
                    console.log(`         -> Attempt ${clipboardAttempts + 1}: Not Facebook URL, retrying...`);
                    clipboardAttempts++;
                }
            } catch (e) {
                console.log(`         -> Attempt ${clipboardAttempts + 1}: Clipboard read error, retrying...`);
                clipboardAttempts++;
            }
        }
        
        if (shareUrl === "N/A") {
            console.log(`         ⚠️ Failed to get Facebook URL after ${maxClipboardAttempts} attempts`);
        }
        
        // ========== STEP 7: Close dialog ==========
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        
        return shareUrl;
        
    } catch (shareError) {
        console.warn(`         ⚠️ Error extract share URL: ${shareError.message.substring(0, 50)}`);
        
        try {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
        } catch (e) {}
        
        return "N/A";
        
    } finally {
        // ========== STEP 8: ALWAYS restore original clipboard ==========
        if (originalClipboard !== null) {
            try {
                await page.evaluate((text) => navigator.clipboard.writeText(text), originalClipboard);
                console.log(`         ✅ Original clipboard restored`);
            } catch (e) {
                console.log(`         -> Cannot restore clipboard`);
            }
        }
    }
}


/**
 * ✅ FIXED: Handle translated posts - Click "See original" untuk dapatkan bahasa Indonesia
 */
async function handleTranslatedContent(page, postEl) {
    try {
        console.log("      -> Checking for translation...");
        
        // ========== STEP 1: Cek apakah ada "See original" button ==========
        const seeOriginalSelectors = [
            // ✅ Priority 1: EXACT dari HTML yang Anda berikan
            'div.x1i10hfl.xjbqb8w.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.xt0psk2.x3ct3a4.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x16tdsg8.x1hl2dhg.xggy1nq.x1a2a7pz.x1heor9g.xkrqix3.x1sur9pj.x1s688f[role="button"]:has-text("See original")',
            // Priority 2: Simplified
            'div[role="button"]:has-text("See original")',
            'div[role="button"]:has-text("Lihat asli")',
            // Priority 3: Parent span search
            'span:has(div[role="button"]:has-text("See original"))',
        ];
        
        let seeOriginalButton = null;
        
        for (const selector of seeOriginalSelectors) {
            const btns = await postEl.locator(selector).all();
            
            // Cari yang benar-benar "See original" (bukan "Translation preferences")
            for (const btn of btns) {
                const text = await btn.textContent();
                if (text && text.includes('See original')) {
                    seeOriginalButton = btn;
                    console.log("      -> Found 'See original' button");
                    break;
                }
            }
            
            if (seeOriginalButton) break;
        }
        
        // Kalau tidak ada translation, return false (lanjut normal)
        if (!seeOriginalButton) {
            console.log("      -> No translation detected");
            return false;
        }
        
        // ========== STEP 2: Simpan konten SEBELUM klik (untuk validasi) ==========
        const beforeContent = await postEl.locator('blockquote div[dir="auto"]').first().textContent().catch(() => '');
        console.log(`      -> Before: "${beforeContent.substring(0, 30)}..."`);
        
        // ========== STEP 3: Klik "See original" ==========
        try {
            await seeOriginalButton.scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(500);
            
            // Try multiple click methods
            let clicked = false;
            
            // Method 1: Regular click
            try {
                await seeOriginalButton.click({ timeout: 5000 });
                clicked = true;
            } catch (e1) {
                // Method 2: Force click
                try {
                    await seeOriginalButton.click({ force: true, timeout: 5000 });
                    clicked = true;
                } catch (e2) {
                    // Method 3: JavaScript click
                    await seeOriginalButton.evaluate(el => el.click());
                    clicked = true;
                }
            }
            
            if (!clicked) {
                console.log("      -> Could not click 'See original'");
                return false;
            }
            
            console.log("      -> Clicked 'See original'");
            
            // ========== STEP 4: WAIT untuk konten berubah ==========
            await page.waitForTimeout(3000); // Wait 3 detik untuk transition
            
            // ========== STEP 5: Validasi konten sudah berubah ==========
            // Cari konten BARU dengan selector dari HTML yang Anda berikan
            const afterContentSelectors = [
                // ✅ Priority 1: EXACT dari HTML setelah klik
                'div[data-ad-rendering-role="story_message"] span[lang="id-ID"] div[dir="auto"]',
                'div[data-ad-comet-preview="message"] span[lang="id-ID"] div[dir="auto"]',
                // Priority 2: Broader
                'div[data-ad-rendering-role="story_message"] div[dir="auto"]',
                'span[lang="id-ID"] div[dir="auto"]',
                // Fallback
                'div[data-ad-preview="message"] div[dir="auto"]',
            ];
            
            let afterContent = '';
            
            for (const selector of afterContentSelectors) {
                const contentEl = postEl.locator(selector).first();
                if (await contentEl.count() > 0) {
                    afterContent = await contentEl.textContent().catch(() => '');
                    if (afterContent && afterContent.trim()) {
                        break;
                    }
                }
            }
            
            // Check if content actually changed
            if (afterContent && afterContent !== beforeContent) {
                console.log(`      ✅ Translation successful: "${afterContent.substring(0, 30)}..."`);
                return true;
            } else {
                console.log("      ⚠️ Content did not change (translation may have failed)");
                return false;
            }
            
        } catch (clickError) {
            console.log(`      -> Error clicking 'See original': ${clickError.message.substring(0, 40)}`);
            return false;
        }
        
    } catch (error) {
        console.warn(`      ⚠️ Error handling translation: ${error.message.substring(0, 40)}`);
        return false;
    }
}

/**
 * ✅ Extract ALL Comments - Complete Flow
 */
async function extractAllComments(page, postEl) {
    const comments = [];
    
    try {
        console.log(`      🗨️  Starting comment extraction...`);

        const globalSeenComments = new Set();
        
        // ========== STEP 1: Click comment count button (e.g. "496 comments") ==========
        const commentButtonSelectors = [
            // ✅ Priority 1: EXACT from USER HTML
            'span.xkrqix3.x1sur9pj:has-text("comments")',
            // Priority 2: More specific with parent
            'div.x1i10hfl[role="button"]:has(span.xkrqix3.x1sur9pj:has-text("comments"))',
            // Priority 3: Alternative
            'div[role="button"]:has(span:has-text("comments"))',
            // Fallback
            'span:has-text("comments")',
        ];
        
        let dialogOpened = false;
        
        for (const selector of commentButtonSelectors) {
            try {
                const commentBtn = postEl.locator(selector).first();
                
                if (await commentBtn.count() > 0) {
                    console.log(`         -> Found comment button with: ${selector.substring(0, 50)}...`);
                    
                    await commentBtn.scrollIntoViewIfNeeded().catch(() => {});
                    await page.waitForTimeout(500);
                    
                    // Get parent button (bukan span langsung)
                    const parentButton = postEl.locator('div[role="button"]:has(span:has-text("comments"))').first();
                    
                    if (await parentButton.count() > 0) {
                        await parentButton.click({ timeout: 5000 });
                        console.log(`         ✓ Comment button clicked`);
                        await page.waitForTimeout(3000);
                    
                        // Verify dialog opened
                        const dialog = page.locator('div[role="dialog"]').first();
                        if (await dialog.count() > 0) {
                            console.log(`         ✓ Comment dialog opened`);
                            dialogOpened = true;
                            break;
                        }
                    }
                }
            } catch (e) {
                console.log(`         -> Selector failed: ${e.message.substring(0, 30)}`);
                continue;
            }
        }
        
        if (!dialogOpened) {
            console.log(`         ℹ️  No comment dialog opened`);
            return [];
        }
        
        // ========== ✅ STEP 1.5: Extract post author (SETELAH DIALOG TERBUKA!) ==========
        let postAuthor = 'Unknown';
        
        try {
            console.log(`         -> Extracting post author from dialog...`);
            
            const dialogHeaderSelectors = [
                // Strategy 1: Dialog heading
                'div[role="dialog"] h2[dir="auto"]',
                'div[role="dialog"] h2 span[dir="auto"]',
                // Strategy 2: Dialog aria-label
                'div[role="dialog"][aria-label]',
                // Strategy 3: First prominent text
                'div[role="dialog"] span.x193iq5w.xeuugli',
            ];
            
            for (const selector of dialogHeaderSelectors) {
                const headerEl = page.locator(selector).first();
                
                if (await headerEl.count() > 0) {
                    let headerText = '';
                    
                    // Try textContent first
                    headerText = await headerEl.textContent().catch(() => '');
                    
                    // Fallback: try aria-label
                    if (!headerText) {
                        headerText = await headerEl.getAttribute('aria-label').catch(() => '');
                    }
                    
                    if (headerText) {
                        // Pattern: "Obon's post" or "Obon Tabroni's post"
                        let match = headerText.match(/(.+)'s post/i);
                        
                        if (match) {
                            postAuthor = match[1].trim();
                            console.log(`         ✅ Post author: ${postAuthor}`);
                            break;
                        }
                        
                        // Alternative pattern: just name (if no "'s post")
                        if (headerText.length > 0 && headerText.length < 100) {
                            postAuthor = headerText.trim();
                            console.log(`         ✅ Post author (alt): ${postAuthor}`);
                            break;
                        }
                    }
                }
            }
            
            if (postAuthor === 'Unknown') {
                console.log(`         ⚠️ Could not extract post author from dialog`);
            }
            
        } catch (e) {
            console.log(`         ⚠️ Error extracting post author: ${e.message.substring(0, 40)}`);
        }
        
        // ========== STEP 2: Click dropdown "Most relevant" (ENHANCED) ==========
        console.log(`         -> Waiting for dropdown to load...`);
        
        // ✅ WAIT LONGER untuk dialog content selesai render
        await page.waitForTimeout(4000); // ⬆️ INCREASED from 2500ms to 4000ms
        
        // ✅ Check for loading indicators
        let loadingCheckAttempts = 0;
        const maxLoadingChecks = 5;
        
        while (loadingCheckAttempts < maxLoadingChecks) {
            const isLoading = await page.locator(
                'div[role="dialog"] div[role="progressbar"], ' +
                'div[role="dialog"] div[data-visualcompletion="loading-state"]'
            ).count() > 0;
            
            if (isLoading) {
                console.log(`         -> Dialog still loading (check ${loadingCheckAttempts + 1}/${maxLoadingChecks})...`);
                await page.waitForTimeout(2000);
                loadingCheckAttempts++;
            } else {
                console.log(`         -> Dialog fully loaded!`);
                break;
            }
        }
        
        // ✅ Extra wait after loading completes
        await page.waitForTimeout(1500);
        
        const dropdownSelectors = [
            // ✅ Priority 1: EXACT from USER HTML (dengan aria-expanded)
            'div[aria-expanded="false"][aria-haspopup="menu"][role="button"]:has(span:has-text("Most relevant"))',
            // Priority 2: Broader (kalau sudah false/true)
            'div[aria-haspopup="menu"][role="button"]:has(span:has-text("Most relevant"))',
            // Priority 3: Classes-based
            'div.x1i10hfl.xjbqb8w[role="button"]:has(span.x193iq5w:has-text("Most relevant"))',
            // Fallback
            'div[role="button"]:has(span:has-text("Most relevant"))',
        ];
        
        let dropdownClicked = false;
        
        // ✅ RETRY MECHANISM for finding dropdown
        for (let attempt = 1; attempt <= 3; attempt++) {
            for (const selector of dropdownSelectors) {
                try {
                    const parentButton = page.locator(selector).first();
                    
                    // ✅ Wait for visible with timeout
                    await parentButton.waitFor({ 
                        state: 'visible', 
                        timeout: 3000 
                    }).catch(() => {});
                    
                    const count = await parentButton.count();
                    if (count === 0) {
                        continue;
                    }
                    
                    console.log(`         -> Found dropdown with: ${selector.substring(0, 60)}... (attempt ${attempt}/3)`);
                    
                    await parentButton.scrollIntoViewIfNeeded().catch(() => {});
                    await page.waitForTimeout(800); // ⬆️ INCREASED from 500ms
                    
                    // ✅ Multiple click strategies
                    let clicked = false;
                    
                    // Try 1: Normal click
                    try {
                        await parentButton.click({ timeout: 5000 });
                        clicked = true;
                    } catch (e1) {
                        // Try 2: Force click
                        try {
                            await parentButton.click({ force: true, timeout: 5000 });
                            clicked = true;
                        } catch (e2) {
                            // Try 3: JS click
                            await parentButton.evaluate(el => el.click());
                            clicked = true;
                        }
                    }
                    
                    if (clicked) {
                        await page.waitForTimeout(3000); // ⬆️ INCREASED from 2500ms
                        
                        // ✅ Verify menu opened
                        const menuOpened = await page.locator('div[role="menu"]').count() > 0;
                        
                        if (menuOpened) {
                            console.log(`         ✅ Dropdown opened successfully!`);
                            dropdownClicked = true;
                            break;
                        } else {
                            console.log(`         ⚠️ Menu didn't open, retrying...`);
                            await page.waitForTimeout(2000);
                        }
                    }
                    
                } catch (e) {
                    console.log(`         -> Dropdown click failed with selector ${dropdownSelectors.indexOf(selector) + 1}: ${e.message.substring(0, 30)}`);
                    continue;
                }
            }
            
            if (dropdownClicked) {
                break; // Success, exit retry loop
            }
            
            // ✅ Wait before retry
            if (attempt < 3) {
                console.log(`         -> Retrying dropdown click (attempt ${attempt + 1}/3)...`);
                await page.waitForTimeout(2000);
            }
        }
        
        if (!dropdownClicked) {
            console.log(`         ⚠️ Could not open dropdown after 3 attempts (continuing with default filter)`);
        }
        
        // ========== STEP 3: Click "All comments" menu item (ROBUST VERSION) ==========
        if (dropdownClicked) {
            console.log(`         -> Looking for comment filter options...`);
            
            // Wait for menu to render
            await page.waitForTimeout(1500);
            
            let allCommentsClicked = false;
            
            try {
                // ✅ STRATEGY: Get ALL menu items and find "All comments" by exact text
                const allMenuItems = await page.locator('div[role="menuitem"]').all();
                
                console.log(`         -> Found ${allMenuItems.length} filter option(s)`);
                
                // Loop through each menuitem
                for (let i = 0; i < allMenuItems.length; i++) {
                    const menuItem = allMenuItems[i];
                    
                    try {
                        // Get all text in this menuitem
                        const itemText = await menuItem.textContent().catch(() => '');
                        
                        console.log(`         -> Option ${i + 1}: "${itemText.substring(0, 30)}..."`);
                        
                        // ✅ EXACT MATCH: "All comments"
                        if (itemText.includes('All comments') || itemText.includes('Show all comments')) {
                            console.log(`         ✅ Found "All comments" (option ${i + 1})! Clicking...`);
                            
                            // Scroll into view
                            await menuItem.scrollIntoViewIfNeeded().catch(() => {});
                            await page.waitForTimeout(500);
                            
                            // Click with retry
                            let clicked = false;
                            
                            // Try 1: Normal click
                            try {
                                await menuItem.click({ timeout: 3000 });
                                clicked = true;
                            } catch (e1) {
                                // Try 2: Force click
                                try {
                                    await menuItem.click({ force: true, timeout: 3000 });
                                    clicked = true;
                                } catch (e2) {
                                    // Try 3: Click the span inside
                                    const spanInside = menuItem.locator('span:has-text("All comments")').first();
                                    if (await spanInside.count() > 0) {
                                        await spanInside.click({ timeout: 3000 });
                                        clicked = true;
                                    }
                                }
                            }
                            
                            if (clicked) {
                                await page.waitForTimeout(3000);
                                console.log(`         ✅ "All comments" selected successfully!`);
                                allCommentsClicked = true;
                                break; // STOP - we found it!
                            } else {
                                console.log(`         ⚠️ Click failed, trying next option...`);
                            }
                        }
                    } catch (itemError) {
                        console.log(`         -> Error checking option ${i + 1}: ${itemError.message.substring(0, 30)}`);
                        continue;
                    }
                }
                
                // ========== FALLBACK: If "All comments" not found ==========
                if (!allCommentsClicked) {
                    console.log(`         ⚠️ "All comments" not found in ${allMenuItems.length} options`);
                    console.log(`         -> Trying fallback: "Newest"`);
                    
                    // Try to find and click "Newest"
                    for (const menuItem of allMenuItems) {
                        const itemText = await menuItem.textContent().catch(() => '');
                        
                        if (itemText.includes('Newest') || itemText.includes('newest comments first')) {
                            console.log(`         -> Clicking "Newest" as fallback...`);
                            
                            try {
                                await menuItem.scrollIntoViewIfNeeded().catch(() => {});
                                await page.waitForTimeout(500);
                                await menuItem.click({ timeout: 3000 });
                                await page.waitForTimeout(2000);
                                console.log(`         ✓ "Newest" selected as fallback`);
                                allCommentsClicked = true; // Mark as clicked
                                break;
                            } catch (e) {
                                console.log(`         ⚠️ Newest click failed`);
                            }
                        }
                    }
                }
                
                // ========== WORST CASE: Just continue with default ==========
                if (!allCommentsClicked) {
                    console.log(`         ℹ️ Using default filter (Most relevant)`);
                }
                
            } catch (error) {
                console.log(`         ⚠️ Error selecting filter: ${error.message.substring(0, 40)}`);
                console.log(`         -> Continuing with default filter...`);
            }
        }
        
        // ========== STEP 4: Find scrollable container (AGGRESSIVE SEARCH!) ==========
        console.log(`         -> Finding scrollable comment area...`);
        
        let scrollableArea = null;
        
        // 🔍 Strategy 1: Exact class dari HTML user
        scrollableArea = page.locator(
            'div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6.xqbnct6.xga75y6'
        ).first();
        
        if (await scrollableArea.count() > 0) {
            console.log(`         ✓ Strategy 1: Found via exact class`);
        }
        
        // 🔍 Strategy 2: Shorter class combination
        if (!scrollableArea || await scrollableArea.count() === 0) {
            console.log(`         -> Strategy 1 failed, trying strategy 2...`);
            scrollableArea = page.locator('div.x1iyjqo2.x1n2onr6.xqbnct6').first();
            
            if (await scrollableArea.count() > 0) {
                console.log(`         ✓ Strategy 2: Found via short class`);
            }
        }
        
        // 🔍 Strategy 3: Any scrollable div in dialog
        if (!scrollableArea || await scrollableArea.count() === 0) {
            console.log(`         -> Strategy 2 failed, trying strategy 3...`);
            
            const allDivs = await page.locator('div[role="dialog"] div').all();
            
            for (let i = 0; i < Math.min(allDivs.length, 20); i++) {
                const div = allDivs[i];
                
                const canScroll = await div.evaluate(el => {
                    return el.scrollHeight > el.clientHeight && 
                           el.scrollHeight > 500; // Must be reasonably tall
                }).catch(() => false);
                
                if (canScroll) {
                    scrollableArea = div;
                    console.log(`         ✓ Strategy 3: Found scrollable div (index ${i})`);
                    break;
                }
            }
        }
        
        // 🔍 Strategy 4: Dialog's main content area
        if (!scrollableArea || await scrollableArea.count() === 0) {
            console.log(`         -> Strategy 3 failed, trying strategy 4...`);
            scrollableArea = page.locator('div[role="dialog"] > div > div').nth(1);
            
            if (await scrollableArea.count() > 0) {
                console.log(`         ✓ Strategy 4: Using nth-child approach`);
            }
        }
        
        // 🔍 Strategy 5: LAST RESORT - dialog itself
        if (!scrollableArea || await scrollableArea.count() === 0) {
            console.log(`         -> All strategies failed, using dialog as container`);
            scrollableArea = page.locator('div[role="dialog"]').first();
        }

        // ❌ FAIL: Still nothing
        if (!scrollableArea || await scrollableArea.count() === 0) {
            console.log(`         ❌ No container found at all`);
            await page.keyboard.press('Escape');
            return [];
        }

        // ✅ TAMBAHAN BARU: DEBUG INFO
        // 🐛 DEBUG: Show what we found
        if (scrollableArea && await scrollableArea.count() > 0) {
            try {
                const debugInfo = await scrollableArea.evaluate(el => {
                    return {
                        tagName: el.tagName,
                        classes: el.className,
                        scrollHeight: el.scrollHeight,
                        clientHeight: el.clientHeight,
                        childCount: el.children.length,
                    };
                }).catch(() => null);
                
                if (debugInfo) {
                    console.log(`         🐛 Container debug:`, debugInfo);
                }
            } catch (e) {
                console.log(`         🐛 Could not get debug info`);
            }
        }

        // ✅ VALIDATE: Check if scrollable
        const scrollInfo = await scrollableArea.evaluate(el => {
            return {
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                canScroll: el.scrollHeight > el.clientHeight,
                offsetTop: el.offsetTop,
            };
        }).catch(() => null);
        
        if (scrollInfo) {
            console.log(`         ℹ️  Scroll info: height=${scrollInfo.scrollHeight}, visible=${scrollInfo.clientHeight}, scrollable=${scrollInfo.canScroll}`);
        }
        
        // ========== STEP 5: Scroll to load all comments (ENHANCED LOADING DETECTION) ==========
        console.log(`         -> Scrolling to load comments...`);
        let previousCount = 0;
        let sameCountTimes = 0;
        const maxSameCount = 8;
        let scrollAttempts = 0;
        const maxScrollAttempts = 100;
        let lastScrollTop = 0;
        let stuckScrollCount = 0;
        const maxStuckCount = 6;
        let lastVisibleCommentEl = null; // ✅ NEW: Track last comment for highlight
        
        while (sameCountTimes < maxSameCount && 
            scrollAttempts < maxScrollAttempts && 
            comments.length < CONFIG.MAX_COMMENTS_PER_POST) {
            
            scrollAttempts++;
            
            // ========== ✅ ENHANCED: WAIT FOR LOADING WITH AUTO-FOCUS ==========
            let loadingWaitAttempts = 0;
            const maxLoadingWait = 10; // ⬆️ Max 10 checks (50 seconds total)
            let loadingDetected = false;
            
            while (loadingWaitAttempts < maxLoadingWait) {
                // ✅ Check for loading indicator (EXACT from user's HTML!)
                const isLoading = await scrollableArea.locator(
                    'div[role="status"][data-visualcompletion="loading-state"][aria-label="Loading..."]'
                ).count() > 0;
                
                if (isLoading) {
                    loadingDetected = true;
                    console.log(`         ⏳ Loading more comments (${loadingWaitAttempts + 1}/${maxLoadingWait})...`);
                    
                    // ✅ KEEP HIGHLIGHT on last visible comment during loading
                    if (lastVisibleCommentEl) {
                        try {
                            await lastVisibleCommentEl.evaluate(el => {
                                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                            }).catch(() => {});
                            
                            // Pulse effect untuk indicate "still loading"
                            await lastVisibleCommentEl.evaluate(el => {
                                el.style.border = '3px solid #ff9800'; // Orange = loading
                                el.style.backgroundColor = '#fff8e1';
                            }).catch(() => {});
                            
                            console.log(`         ✨ Focused on last comment while loading...`);
                        } catch (e) {
                            // Non-critical
                        }
                    }
                    
                    // ✅ WAIT LONGER - 5 seconds per check
                    await page.waitForTimeout(5000);
                    loadingWaitAttempts++;
                } else {
                    // ✅ Loading finished!
                    if (loadingDetected && loadingWaitAttempts > 0) {
                        console.log(`         ✅ Loading complete after ${loadingWaitAttempts} check(s)!`);
                    }
                    break;
                }
            }
            
            // ✅ Check: If loading never stopped after max checks → might be stuck
            if (loadingWaitAttempts >= maxLoadingWait) {
                console.log(`         ⚠️ Loading didn't stop after ${maxLoadingWait} checks (50s) - continuing anyway...`);
            }
            
            // ✅ Extra wait after loading finishes (let DOM settle)
            if (loadingDetected) {
                await page.waitForTimeout(2000);
            }
            
            // ========== SCROLL (Multiple methods) ==========
            try {
                // Method 1: scrollTop to max
                await scrollableArea.evaluate(el => {
                    el.scrollTop = el.scrollHeight;
                }).catch(() => {});
                
                // Method 2: scrollBy chunks
                await scrollableArea.evaluate(el => {
                    el.scrollBy(0, 1000);
                }).catch(() => {});
                
                // Method 3: Scroll to last visible comment
                const lastComment = scrollableArea.locator('div[role="article"]').last();
                if (await lastComment.count() > 0) {
                    await lastComment.scrollIntoViewIfNeeded().catch(() => {});
                    lastVisibleCommentEl = lastComment; // ✅ Update last comment reference
                }
                
            } catch (e) {
                console.log(`         -> Scroll error: ${e.message.substring(0, 30)}`);
            }
            
            // ✅ LONGER WAIT after scroll (allow Facebook to render)
            await page.waitForTimeout(CONFIG.COMMENT_SCROLL_DELAY + 2000); // +2s extra
            
            // ========== CHECK SCROLL POSITION ==========
            const currentScrollTop = await scrollableArea.evaluate(el => el.scrollTop).catch(() => -1);
            
            if (currentScrollTop === lastScrollTop && currentScrollTop !== -1) {
                stuckScrollCount++;
                console.log(`         -> Scroll position stuck (${stuckScrollCount}/${maxStuckCount})`);
                
                // ✅ BEFORE GIVING UP: Check if there's a "View more comments" button
                if (stuckScrollCount >= maxStuckCount) {
                    const viewMoreButton = await scrollableArea.locator(
                        'div[role="button"]:has-text("View more comments"), ' +
                        'span:has-text("View more comments"), ' +
                        'div[role="button"]:has-text("View previous comments")'
                    ).first();
                    
                    if (await viewMoreButton.count() > 0) {
                        console.log(`         -> Found "View more" button, clicking...`);
                        
                        try {
                            await viewMoreButton.scrollIntoViewIfNeeded().catch(() => {});
                            await page.waitForTimeout(500);
                            await viewMoreButton.click({ timeout: 3000 });
                            await page.waitForTimeout(3000);
                            
                            stuckScrollCount = 0; // Reset counter
                            console.log(`         ✅ "View more" clicked, continuing...`);
                            continue; // Try scrolling again
                        } catch (e) {
                            console.log(`         -> Could not click "View more"`);
                        }
                    }
                    
                    // ✅ FINAL CHECK: No loading indicator + stuck = really done
                    const finalLoadingCheck = await scrollableArea.locator(
                        'div[role="status"][data-visualcompletion="loading-state"]'
                    ).count() > 0;
                    
                    if (!finalLoadingCheck) {
                        console.log(`         ✅ No loading indicator + scroll stuck = End reached!`);
                        break;
                    } else {
                        console.log(`         ⚠️ Still loading detected, waiting more...`);
                        stuckScrollCount = 0; // Reset and continue
                    }
                }
                
            } else {
                stuckScrollCount = 0;
                lastScrollTop = currentScrollTop;
            }
            
            // ========== COUNT VISIBLE COMMENTS ==========
            const currentComments = await extractVisibleComments(scrollableArea, postAuthor, page);
            
            // ✅ FILTER: Hanya tambahkan yang BELUM pernah di-add
            const newCommentsOnly = currentComments.filter(comment => {
                const fingerprint = `${comment.comment_author}|${comment.comment_text.substring(0, 50)}`;
                
                if (!globalSeenComments.has(fingerprint)) {
                    globalSeenComments.add(fingerprint);
                    return true; // NEW comment
                }
                return false; // DUPLICATE
            });
            
            // ✅ Add ONLY new comments
            comments.push(...newCommentsOnly);
            const currentCount = comments.length;
            
            if (currentCount === previousCount) {
                sameCountTimes++;
                console.log(`         -> Same count (${sameCountTimes}/${maxSameCount}): ${currentCount} comments`);
                
                // ✅ If same count AND no loading → likely done
                const noLoading = await scrollableArea.locator(
                    'div[role="status"][data-visualcompletion="loading-state"]'
                ).count() === 0;
                
                if (noLoading && sameCountTimes >= 3) {
                    console.log(`         ✅ No new comments + no loading = Finished!`);
                    break;
                }
                
            } else {
                sameCountTimes = 0;
                const newAdded = currentCount - previousCount;
                console.log(`         -> Loaded: ${currentCount} comments (+${newAdded} NEW, ${currentComments.length - newAdded} duplicate)`);
            }
            
            previousCount = currentCount;
            
            // ========== DOUBLE-CHECK: Really at the end? ==========
            if (sameCountTimes >= maxSameCount - 1) {
                console.log(`         -> Double-checking if truly at end...`);
                await page.waitForTimeout(5000);
                
                // Check for loading one more time
                const finalCheck = await scrollableArea.locator(
                    'div[role="status"][data-visualcompletion="loading-state"]'
                ).count() > 0;
                
                if (finalCheck) {
                    console.log(`         -> Still loading, resetting counter...`);
                    sameCountTimes = 0;
                    continue;
                }
                
                // Check for NEW comments
                const recheckComments = await extractVisibleComments(scrollableArea, postAuthor, page);
                
                let foundMore = false;
                for (const comment of recheckComments) {
                    const fingerprint = `${comment.comment_author}|${comment.comment_text.substring(0, 50)}`;
                    if (!globalSeenComments.has(fingerprint)) {
                        foundMore = true;
                        break;
                    }
                }
                
                if (foundMore) {
                    console.log(`         -> Found more NEW comments!`);
                    sameCountTimes = 0;
                    continue;
                }
                
                // Check for "View more" button
                const viewMoreBtn = await scrollableArea.locator(
                    'div[role="button"]:has-text("View more"), span:has-text("View more")'
                ).first();
                
                if (await viewMoreBtn.count() > 0) {
                    console.log(`         -> Final check: "View more" button found!`);
                    try {
                        await viewMoreBtn.click({ timeout: 3000 });
                        await page.waitForTimeout(3000);
                        sameCountTimes = 0;
                        console.log(`         -> Clicked, continuing...`);
                        continue;
                    } catch (e) {
                        console.log(`         -> Could not click final "View more"`);
                    }
                }
            }
        }
        
        // ✅ CLEAR highlight dari last comment sebelum close
        if (lastVisibleCommentEl) {
            try {
                await lastVisibleCommentEl.evaluate(el => {
                    el.style.border = '';
                    el.style.backgroundColor = '';
                }).catch(() => {});
            } catch (e) {}
        }
        
        console.log(`         ✓ Scroll complete after ${scrollAttempts} attempts`);
        console.log(`         ✅ Extracted ${comments.length} comments`);
        
        // ========== ✅ FIX: REMOVE STEP 6 - Comments sudah dikumpulkan di loop! ==========
        // ❌ HAPUS BARIS INI:
        // const finalComments = await extractVisibleComments(scrollableArea, postAuthor, page);
        
        console.log(`         ✅ Extracted ${comments.length} comments`); // ✅ Use comments, not finalComments
        
        // Close dialog
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        
        return comments; // ✅ FIX: Return comments, not finalComments
        
    } catch (error) {
        console.warn(`         ⚠️ Comment extraction error: ${error.message.substring(0, 50)}`);
        await page.keyboard.press('Escape').catch(() => {});
        return [];
    }
}

/**
 * ✅ UPDATED: Extract visible comments from container (with page for timestamp)
 * @param {Locator} containerEl - Scrollable container
 * @param {string} postAuthor - Author of the post
 * @param {Page} page - Page object (for full timestamp extraction)
 * @returns {Promise<Array>} Array of comment objects
 */
async function extractVisibleComments(containerEl, postAuthor = 'Unknown', page = null) {
    const comments = [];
    const seenComments = new Set();
    
    try {
        // Find comment containers
        const commentSelectors = [
            'div[role="article"][aria-label*="Comment by"]',
            'div.x1lliihq.xjkvuk6.x1iorvi4',
            'div.xwib8y2.xpdmqnj.x1g0dm76.x1y1aw1k',
            'div.x18xomjl.xbcz3fp > div',
            'div[class*="x1lliihq"]',
        ];
        
        let lastNewCommentEl = null; // ✅ TRACK comment terakhir yang BARU
        
        for (const selector of commentSelectors) {
            const commentContainers = await containerEl.locator(selector).all();
            
            if (commentContainers.length > 0) {
                console.log(`            -> Found ${commentContainers.length} comment container(s) with: ${selector.substring(0, 40)}...`);
                
                for (const commentEl of commentContainers) {
                    try {
                        // ❌ NO HIGHLIGHT HERE - extract only
                        const comment = await extractSingleComment(commentEl, postAuthor, page);
                        
                        if (comment && comment.comment_text) {
                            const commentKey = `${comment.comment_author}|${comment.comment_text.substring(0, 50)}`;
                            
                            if (!seenComments.has(commentKey)) {
                                comments.push(comment);
                                seenComments.add(commentKey);
                                lastNewCommentEl = commentEl; // ✅ TRACK element yang baru
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }
                
                break; // Found comments, stop
            }
        }
        
        // ✅ HIGHLIGHT HANYA COMMENT TERAKHIR YANG BARU
        if (lastNewCommentEl && page) {
            try {
                await highlightCurrentComment(lastNewCommentEl, page);
                console.log(`            ✨ Focused on LATEST new comment`);
            } catch (e) {
                // Non-critical
            }
        }
        
    } catch (error) {
        console.warn(`Error extracting visible comments: ${error.message}`);
    }
    
    return comments;
}


/**
 * ✅ ENHANCED: Extract full comment timestamp via hover with NEW selectors
 * @param {Locator} commentEl - Comment element
 * @param {Page} page - Page object
 * @returns {Promise<string>} Full timestamp or relative time
 */
async function extractCommentFullTimestamp(commentEl, page) {
    try {
        console.log("            🕐 Extracting full timestamp...");
        
        // ========== STEP 1: Find timestamp link ==========
        const timestampSelectors = [
            // ✅ NEW: Exact dari HTML user (priority!)
            'li.html-li span.html-span div.html-div a[href*="comment_id"][role="link"]',
            // Existing selectors (fallback)
            'li span a[href*="comment_id"]',
            'a[href*="comment_id"][role="link"]',
        ];
        
        let timestampLink = null;
        
        for (const selector of timestampSelectors) {
            const link = commentEl.locator(selector).first();
            if (await link.count() > 0) {
                timestampLink = link;
                console.log(`            -> Found timestamp link: ${selector.substring(0, 40)}...`);
                break;
            }
        }
        
        if (!timestampLink) {
            console.log("            ⚠️ No timestamp link found");
            return 'N/A';
        }
        
        // ========== STEP 2: Get relative time as fallback ==========
        const relativeTime = await timestampLink.textContent().catch(() => '');
        console.log(`            -> Relative time: ${relativeTime}`);
        
        if (!relativeTime || !/^\d+[mhdwy]$/i.test(relativeTime.trim())) {
            console.log("            ⚠️ Invalid relative time format");
            return 'N/A';
        }
        
        // ========== STEP 3: Try hover for full timestamp ==========
        try {
            // Reset mouse position
            await page.mouse.move(0, 0);
            await page.waitForTimeout(300);
            
            // Scroll into view (smooth, centered)
            await timestampLink.evaluate(el => {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }).catch(() => {});
            await page.waitForTimeout(500);
            
            // Get position and hover
            const box = await timestampLink.boundingBox().catch(() => null);
            
            if (!box) {
                console.log("            ⚠️ Cannot get bounding box");
                return relativeTime.trim();
            }
            
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            
            console.log(`            -> Hovering to (${Math.round(x)}, ${Math.round(y)})...`);
            
            // Slow movement to trigger tooltip
            await page.mouse.move(x, y, { steps: 8 });
            await page.waitForTimeout(3500); // ⬆️ INCREASED wait time
            
            // ========== STEP 4: Check for tooltip (MULTIPLE STRATEGIES) ==========
            const tooltipSelectors = [
                // ✅ Strategy 1: EXACT dari HTML user (BEST!)
                'div[role="tooltip"] span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x1xmvt09.x1nxh6w3.x1sibtaa.xo1l8bm.xzsf02u[dir="auto"]',
                // Strategy 2: Shorter version
                'div[role="tooltip"] span.x193iq5w.xeuugli.x13faqbe.x1vvkbs',
                // Strategy 3: Generic
                'div[role="tooltip"] span.x193iq5w.xeuugli',
                'div[role="tooltip"] span[dir="auto"]',
                'div[role="tooltip"] span',
            ];
            
            for (const selector of tooltipSelectors) {
                const tooltip = page.locator(selector).first();
                
                if (await tooltip.count() > 0) {
                    const fullTimestamp = await tooltip.textContent().catch(() => '');
                    
                    console.log(`            -> Tooltip text: ${fullTimestamp}`);
                    
                    // ✅ Validate: must contain year AND proper format
                    if (fullTimestamp && 
                        fullTimestamp.match(/\d{4}/) && 
                        fullTimestamp.match(/\d{1,2}:\d{2}/) && // Has time (HH:MM)
                        fullTimestamp.length > 15) {
                        
                        console.log(`            ✅ Full timestamp extracted!`);
                        
                        // Reset mouse
                        await page.mouse.move(0, 0).catch(() => {});
                        
                        return cleanTextForCSV(fullTimestamp);
                    }
                }
            }
            
            console.log("            ⚠️ Tooltip not found or invalid");
            
        } catch (hoverError) {
            console.log(`            ⚠️ Hover error: ${hoverError.message.substring(0, 40)}`);
        }
        
        // Reset mouse anyway
        await page.mouse.move(0, 0).catch(() => {});
        
        // ========== FALLBACK: Return relative time ==========
        console.log(`            ⚠️ Fallback to relative time: ${relativeTime.trim()}`);
        return relativeTime.trim();
        
    } catch (error) {
        console.log(`            ❌ Error: ${error.message.substring(0, 40)}`);
        return 'N/A';
    }
}


/**
 * ✅ NEW: Visual highlight untuk comment yang sedang diproses
 * @param {Locator} commentEl - Comment element
 * @param {Page} page - Page object
 */
async function highlightCurrentComment(commentEl, page) {
    try {
        // Scroll ke comment (smooth, centered)
        await commentEl.evaluate(el => {
            el.scrollIntoView({ 
                behavior: 'smooth', 
                block: 'center' 
            });
        }).catch(() => {});
        
        // Add visual highlight (border merah tebal)
        await commentEl.evaluate(el => {
            el.style.border = '3px solid #ff0000';
            el.style.backgroundColor = '#fff3cd';
            el.style.transition = 'all 0.3s ease';
        }).catch(() => {});
        
        await page.waitForTimeout(500);
        
    } catch (e) {
        // Non-critical, continue
    }
}

/**
 * ✅ NEW: Remove highlight setelah selesai
 * @param {Locator} commentEl - Comment element
 */
async function removeHighlight(commentEl) {
    try {
        await commentEl.evaluate(el => {
            el.style.border = '';
            el.style.backgroundColor = '';
        }).catch(() => {});
    } catch (e) {}
}

/**
 * ✅ COMPLETE: Extract single comment with FULL timestamp support
 * @param {Locator} commentEl - Comment element
 * @param {string} postAuthor - Author of the post
 * @param {Page} page - Page object for hover (REQUIRED for full timestamp!)
 * @returns {Promise<Object|null>} Comment object or null
 */
async function extractSingleComment(commentEl, postAuthor = 'Unknown', page = null) {
    try {
        const comment = {
            post_author: postAuthor,
            comment_author: 'Unknown',
            comment_text: '',
            comment_timestamp: 'N/A',
            comment_reactions: 0,
        };
        
        // ========== EXTRACT AUTHOR (EXACT from user HTML) ==========
        const authorSelectors = [
            // ✅ PRIORITY 1: EXACT path dari HTML
            'div.xwib8y2.xpdmqnj.x1g0dm76.x1y1aw1k span.xt0psk2 span.xjp7ctv a span.x3nfvp2 span.x193iq5w.xeuugli',
            
            // Priority 2: Shorter path (more flexible)
            'a[role="link"] span.x193iq5w.xeuugli.x13faqbe.x1vvkbs',
            
            // Priority 3: Generic
            'a[href*="comment_id"] span.x193iq5w',
            'a[role="link"] span.x193iq5w',
        ];
        
        for (const selector of authorSelectors) {
            const authorEl = commentEl.locator(selector).first();
            if (await authorEl.count() > 0) {
                const text = await authorEl.textContent().catch(() => null);
                if (text?.trim() && text.length > 1 && text.length < 100) {
                    comment.comment_author = cleanTextForCSV(text.trim());
                    break;
                }
            }
        }
        
        // ========== EXTRACT TEXT (EXACT from user HTML) ==========
        const textSelectors = [
            // ✅ PRIORITY 1: EXACT dari HTML user
            'div.x1lliihq.xjkvuk6.x1iorvi4 span[dir="auto"][lang="id-ID"] div.xdj266r div[dir="auto"]',
            
            // Priority 2: Without lang attribute (for English comments)
            'div.x1lliihq.xjkvuk6.x1iorvi4 span[dir="auto"] div.xdj266r div[dir="auto"]',
            
            // Priority 3: Direct to final div
            'div.x1lliihq.xjkvuk6.x1iorvi4 div[dir="auto"][style*="text-align"]',
            
            // Priority 4: Get parent container and extract all text
            'div.x1lliihq.xjkvuk6.x1iorvi4',
        ];
        
        for (let selectorIndex = 0; selectorIndex < textSelectors.length; selectorIndex++) {
            const selector = textSelectors[selectorIndex];
            
            if (selectorIndex < 3) {
                // For specific selectors: get text directly
                const textDivs = await commentEl.locator(selector).all();
                
                if (textDivs.length > 0) {
                    const textParts = [];
                    
                    for (const div of textDivs) {
                        const text = await div.textContent().catch(() => '');
                        const cleaned = text.trim();
                        
                        // Skip empty, timestamps, button text
                        if (cleaned.length > 2 && 
                            !cleaned.match(/^\d+[mhdwy]$/i) &&
                            !cleaned.toLowerCase().includes('like') &&
                            !cleaned.toLowerCase().includes('reply') &&
                            !cleaned.toLowerCase().includes('see translation')) {
                            textParts.push(cleaned);
                        }
                    }
                    
                    if (textParts.length > 0) {
                        // Remove duplicates
                        const uniqueTexts = [...new Set(textParts)];
                        comment.comment_text = cleanTextForCSV(uniqueTexts.join(' '));
                        break;
                    }
                }
                
            } else {
                // For container selector: extract all div[dir="auto"] inside
                const container = commentEl.locator(selector).first();
                
                if (await container.count() > 0) {
                    const allTextDivs = await container.locator('div[dir="auto"]').allTextContents();
                    const textParts = [];
                    
                    for (const text of allTextDivs) {
                        const cleaned = text.trim();
                        
                        // Filter out UI elements
                        if (cleaned.length > 2 &&
                            !cleaned.match(/^\d+[mhdwy]$/i) &&
                            !cleaned.toLowerCase().includes('like') &&
                            !cleaned.toLowerCase().includes('reply') &&
                            !cleaned.toLowerCase().includes('see translation') &&
                            !cleaned.toLowerCase().includes('hide or report')) {
                            textParts.push(cleaned);
                        }
                    }
                    
                    if (textParts.length > 0) {
                        const uniqueTexts = [...new Set(textParts)];
                        comment.comment_text = cleanTextForCSV(uniqueTexts.join(' '));
                        break;
                    }
                }
            }
        }
        
        // ✅ VALIDATION: Skip if no text
        if (!comment.comment_text || comment.comment_text.length === 0) {
            return null;
        }
        
        // ========== EXTRACT REACTIONS (from aria-label) ==========
        try {
            const reactionSelectors = [
                // ✅ EXACT from user HTML
                'div[aria-label*="reaction"][role="button"]',
                'span.html-span div[aria-label*="reaction"]',
            ];
            
            for (const selector of reactionSelectors) {
                const reactionEl = commentEl.locator(selector).first();
                
                if (await reactionEl.count() > 0) {
                    const ariaLabel = await reactionEl.getAttribute('aria-label').catch(() => null);
                    
                    if (ariaLabel) {
                        // Pattern: "15 reactions; see who reacted to this"
                        const match = ariaLabel.match(/(\d+)\s+reactions?/i);
                        if (match) {
                            comment.comment_reactions = parseInt(match[1], 10);
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            // Keep default 0
        }
        
        // ========== ✅ EXTRACT FULL TIMESTAMP (NEW!) ==========
        if (page) {
            // Use hover method for full timestamp
            comment.comment_timestamp = await extractCommentFullTimestamp(commentEl, page);
        } else {
            // Fallback: extract relative time only (no hover)
            try {
                const timestampSelectors = [
                    'li span a[href*="comment_id"]',
                    'a[href*="comment_id"][role="link"]',
                ];
                
                for (const selector of timestampSelectors) {
                    const timestampEl = commentEl.locator(selector).first();
                    
                    if (await timestampEl.count() > 0) {
                        const text = await timestampEl.textContent().catch(() => null);
                        
                        // Validate format: "1h", "2d", "30m", etc.
                        if (text?.trim() && /^\d+[mhdwy]$/i.test(text.trim())) {
                            comment.comment_timestamp = text.trim();
                            break;
                        }
                    }
                }
            } catch (e) {
                // Keep default 'N/A'
            }
        }
        
        // ========== DEBUG LOGGING ==========
        if (comment.comment_text) {
            console.log(`         ✅ TEXT: "${comment.comment_text.substring(0, 50)}..."`);
            console.log(`         ✅ AUTHOR: "${comment.comment_author}"`);
            console.log(`         ✅ TIME: "${comment.comment_timestamp}"`);
            console.log(`         ✅ REACTIONS: ${comment.comment_reactions}`);
        }
        
        // ✅ TAMBAH INI DI AKHIR (sebelum return)!
        if (page && comment.comment_text) {
            await removeHighlight(commentEl);
        }

        return comment;
        
    } catch (error) {
        console.warn(`         ⚠️ Comment extraction error: ${error.message.substring(0, 40)}`);
        return null;
    }
}


/**
 * ✅ NEW: Warm up Facebook's tooltip system (CRITICAL for first post!)
 */
async function warmUpTooltipSystem(page) {
    console.log("\n🔥 Warming up tooltip system...");
    
    try {
        // Step 1: Reset mouse position
        await page.mouse.move(0, 0);
        await page.waitForTimeout(500);
        
        // Step 2: Find ANY link on the page to practice hover
        const dummyLinks = await page.locator('a[role="link"]').all();
        
        if (dummyLinks.length > 0) {
            // Pick 2-3 random links to hover (warm up system)
            const linksToTest = dummyLinks.slice(0, 3);
            
            for (const link of linksToTest) {
                try {
                    const box = await link.boundingBox().catch(() => null);
                    if (box) {
                        await page.mouse.move(
                            box.x + box.width / 2, 
                            box.y + box.height / 2, 
                            { steps: 3 }
                        );
                        await page.waitForTimeout(1000); // Wait for potential tooltip
                        console.log("   -> Warmed up 1 link");
                    }
                } catch (e) {
                    continue;
                }
            }
        }
        
        // Step 3: Reset mouse again
        await page.mouse.move(0, 0);
        await page.waitForTimeout(800);
        
        console.log("   ✅ Tooltip system warmed up!\n");
        
    } catch (error) {
        console.log(`   ⚠️ Warm up failed: ${error.message.substring(0, 40)}`);
        // Non-critical, continue anyway
    }
}

/**
 * ✅ NEW: Scrape posts from account profile (NO SEARCH, direct to profile)
 */
async function scrapeAccountPosts(page, accountUrl, maxPosts, startFromPost = 0) {
    console.log(`\n🔍 Scraping account: ${accountUrl} (Target: ${maxPosts} posts)`);
    
    if (startFromPost > 0) {
        console.log(`   ↪️  Resuming from post #${startFromPost + 1}`);
    }
    
    let postsData = [];
    let scrollTanpaHasil = 0;

    const skipReasons = {
        alreadyScraped: 0,
        noValidLink: 0,
        invalidTimestamp: 0,
        invalidUrl: 0,
        detachedElement: 0,
        profileCard: 0,      // ✅ NEW
        peopleCard: 0,       // ✅ NEW
        suggestedCard: 0,    // ✅ NEW
        sponsored: 0,        // ✅ NEW
        groupPromo: 0,       // ✅ NEW
        eventCard: 0,        // ✅ NEW
        marketplace: 0,      // ✅ NEW
        emptyContent: 0,     // ✅ NEW
        otherErrors: 0
    };
    
    try {
        // ✅ STEP 1: Go to account profile
        await page.goto(accountUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);
        console.log(`   ✓ Profile page loaded`);

        // ✅ STEP 2: Wait for Posts section to load
        console.log("   > Waiting for Posts section...");

        // Strategy 1: Wait for "Posts" heading (most reliable)
        const postsSectionSelectors = [
            'h2:has-text("Posts")',
            'h2 span:has-text("Posts")',
            'div.x9f619.x1n2onr6.x1ja2u2z.xeuugli.xs83m0k', // Parent container from HTML
        ];

        let postsSectionFound = false;
        for (const selector of postsSectionSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 10000 });
                console.log(`   ✓ Posts section found (selector: ${postsSectionSelectors.indexOf(selector) + 1})`);
                postsSectionFound = true;
                break;
            } catch (e) {
                console.log(`   ⚠️ Selector ${postsSectionSelectors.indexOf(selector) + 1} not found, trying next...`);
            }
        }

        if (!postsSectionFound) {
            throw new Error('Posts section not found after trying all selectors');
        }

        // ✅ TAMBAH BAGIAN INI
        await warmUpTooltipSystem(page);
        console.log("😴 Waiting for page to fully settle...");
        await page.waitForTimeout(5000);

        // Wait for posts to appear (with aria-posinset)
        await page.waitForTimeout(2000); // Let posts load

        const postSelector = 'div[aria-posinset]'; // Don't require [role="article"] yet
        console.log("   > Feed postingan ditemukan. Memulai ekstraksi data...");


        // ✅ MAIN EXTRACTION LOOP - IMPROVED VERSION
        let postIndex = 0;
        let noNewPostsCount = 0;
        const MAX_NO_NEW_POSTS = 5;
        let lastKnownPostCount = 0;
        let currentScrollUrls = new Set();

        while (postsData.length < maxPosts) {
            // ========== A. GET ALL POSTS (with fallback) ==========
            let allPosts = await page.locator(postSelector).all();
            
            if (allPosts.length === 0) {
                allPosts = await page.locator('div[role="article"]').all();
            }
            
            if (allPosts.length === 0) {
                console.log("   ⚠️ No posts found, scrolling...");
                await page.evaluate(() => window.scrollBy(0, 800));
                await page.waitForTimeout(2000);
                noNewPostsCount++;
                
                if (noNewPostsCount >= MAX_NO_NEW_POSTS) {
                    console.log("   ⚠️ No posts after multiple scrolls. Stopping.");
                    break;
                }
                continue;
            }
            
            // ========== B. CHECK FOR NEW POSTS ==========
            if (allPosts.length === lastKnownPostCount) {
                noNewPostsCount++;
                console.log(`   ⚠️ No new posts (${noNewPostsCount}/${MAX_NO_NEW_POSTS})`);
            } else {
                noNewPostsCount = 0;
                lastKnownPostCount = allPosts.length;
            }
            
            if (noNewPostsCount >= MAX_NO_NEW_POSTS) {
                console.log("   ✅ No new posts after scrolling. Finished.");
                break;
            }
            
            // ========== C. CHECK END OF FEED ==========
            const endOfFeedSelectors = [
                'div:has-text("You\'ve seen all posts")',
                'div:has-text("Tidak ada lagi postingan")',
            ];
            
            for (const selector of endOfFeedSelectors) {
                if (await page.locator(selector).first().count() > 0) {
                    console.log("   ✅ End of feed detected");
                    noNewPostsCount = MAX_NO_NEW_POSTS;
                    break;
                }
            }
            
            if (noNewPostsCount >= MAX_NO_NEW_POSTS) break;
            
            // ========== D. PROCESS POSTS (only NEW ones) ==========
            const scrollCycleUrls = new Set();
            
            for (let i = postIndex; i < allPosts.length && postsData.length < maxPosts; i++) {
                postIndex = i + 1; // ✅ INCREMENT tracker
                // ✅ Skip posts before resume point
                if (i < startFromPost) {
                    console.log(`   ⏭️  Skipping post #${i + 1} (before resume point)`);
                    continue;
                }
                
                const postEl = allPosts[i];
                
                // ========== D1. SKIP CHECKS (KEEP YOUR EXISTING CODE) ==========
                try {
                    const isAttached = await postEl.evaluate(el => el.isConnected).catch(() => false);
                    if (!isAttached) {
                        skipReasons.detachedElement++;
                        continue;
                    }
                    
                    const isProfileCard = await postEl.locator('div[role="button"]:has-text("Follow")').count() > 0;
                    if (isProfileCard) {
                        console.log(`   ⏭️  Post #${i + 1}: Skipped (profile card)`);
                        skipReasons.profileCard++;
                        continue;
                    }
                    
                    const isSponsoredPost = await postEl.locator('span:has-text("Sponsored")').count() > 0;
                    if (isSponsoredPost) {
                        console.log(`   ⏭️  Post #${i + 1}: Skipped (sponsored)`);
                        skipReasons.sponsored++;
                        continue;
                    }
                    
                    const hasAnyContent = await postEl.locator('img[src*="scontent"], video, span[dir="auto"]').count() > 0;
                    if (!hasAnyContent) {
                        console.log(`   ⏭️  Post #${i + 1}: Skipped (empty)`);
                        skipReasons.emptyContent++;
                        continue;
                    }
                    
                    await postEl.scrollIntoViewIfNeeded({ behavior: 'smooth' }).catch(() => {});
                    await page.waitForTimeout(500);
                    
                } catch (checkError) {
                    skipReasons.otherErrors++;
                    continue;
                }
                
                // ========== D2. URL CHECK ==========
                const quickResult = await quickExtractUrl(postEl);
                if (!quickResult) {
                    console.log(`   ⏭️  Post #${i + 1}: No valid link`);
                    skipReasons.noValidLink++;
                    continue;
                }
                
                const postUrl = quickResult.url;
                scrollCycleUrls.add(postUrl);
                console.log(`   📍 Post #${i + 1}: ${postUrl.substring(0, 80)}...`);
                
                // ========== D3. DUPLICATE CHECK ==========
                if (allScrapedUrls.has(postUrl)) {
                    console.log(`   ⏭️  Post #${i + 1}: DUPLICATE`);
                    skipReasons.alreadyScraped++;
                    continue;
                }
                
                const postId = extractPostId(postUrl);
                if (postId && allScrapedUrls.has(`postid:${postId}`)) {
                    console.log(`   ⏭️  Post #${i + 1}: DUPLICATE POST ID`);
                    skipReasons.alreadyScraped++;
                    continue;
                }
                
                await checkRateLimit();
                
                // ========== D4. EXTRACT POST DATA (KEEP YOUR EXISTING CODE) ==========
                try {
                    console.log(`\n   🔎 Extracting post #${i + 1}...`);
                    
                    const timestampLinkEl = quickResult.timestampLinkEl;
                    
                    let postTimestamp = "N/A";
                    if (timestampLinkEl) {
                        // ✅ SPECIAL HANDLING untuk POST PERTAMA
                        const isFirstPost = (i === 0 || i === startFromPost);
                        const maxRetries = isFirstPost ? 5 : 3; // Post pertama: 5x retry!
                        const extraWait = isFirstPost ? 2000 : 0; // Post pertama: +2s delay
                        
                        if (isFirstPost) {
                            console.log("\n      🎯 FIRST POST - Using enhanced extraction...");
                            
                            // Extra pre-hover untuk post pertama
                            await page.mouse.move(0, 0);
                            await page.waitForTimeout(1000);
                            
                            // Scroll dengan offset (jangan tepat di edge)
                            await postEl.evaluate(el => {
                                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                            });
                            await page.waitForTimeout(2000);
                        }
                        
                        await page.waitForTimeout(extraWait);
                        
                        postTimestamp = await extractTimestampWithRetry(
                            postEl,
                            timestampLinkEl,
                            page,
                            maxRetries
                        );
                        console.log(`      -> Timestamp: ${postTimestamp}`);
                        
                        // ✅ DEBUG PAUSE
                        await debugPause(`Timestamp extracted: ${postTimestamp}`);
                        
                        if (!isValidTimestamp(postTimestamp)) {
                            // ✅ POST PERTAMA: Jangan skip langsung, coba sekali lagi!
                            if (isFirstPost && postTimestamp === "N/A") {
                                console.log("      🔄 First post failed, ONE MORE TRY...");
                                
                                // Full reset
                                await page.mouse.move(0, 0);
                                await page.waitForTimeout(2000);
                                
                                // Re-scroll
                                await postEl.scrollIntoViewIfNeeded();
                                await page.waitForTimeout(3000);
                                
                                // Final attempt (direct call, no retry)
                                postTimestamp = await extractTimestamp(postEl, timestampLinkEl, page);
                                
                                if (isValidTimestamp(postTimestamp)) {
                                    console.log("      ✅ SUCCESS on final attempt!");
                                } else {
                                    console.log("      ❌ First post extraction FAILED after all attempts");
                                    skipReasons.invalidTimestamp++;
                                    continue;
                                }
                            } else {
                                skipReasons.invalidTimestamp++;
                                continue;
                            }
                        }
                    }
                    const authorName = await extractAuthor(postEl);
                    
                    // ✅ DEBUG PAUSE
                    await debugPause(`Author extracted: ${authorName}`);
                    
                    const contentText = await extractContent(postEl, page);  // ⬅️ UBAH INI! Tambah ', page'
                    const reactions_total = await extractReactions(postEl, page, i + 1);
                    const comments = await extractComments(postEl, page, i + 1);
                    const shares = await extractShares(postEl, page, i + 1);
                    
                    // Extract comment details
                    let comment_details = [];
                    if (CONFIG.EXTRACT_COMMENTS && comments > 0) {
                        console.log(`      🗨️  Extracting comment details (${comments} comments)...`);
                        try {
                            comment_details = await extractAllComments(page, postEl);
                            console.log(`      ✅ Successfully extracted ${comment_details.length} comment(s)`);
                            
                            // ✅ SAVE TO SEPARATE CSV FILE
                            if (comment_details.length > 0) {
                                await saveCommentsToCSV(
                                    comment_details,
                                    authorName,  // ✅ BENAR (sesuai nama variable di atas)
                                    postUrl,
                                    CONFIG.csv_base_folder  // ✅ BENAR (pakai config folder)
                                );
                            }
                            
                        } catch (commentError) {
                            console.warn(`      ⚠️  Comment extraction error: ${commentError.message.substring(0, 50)}`);
                            comment_details = [];
                        }
                    }

                    // ✅ CORRECT (pastikan pakai nama variable yang benar):
                    const post = {
                        author: authorName,
                        location: "N/A",
                        timestamp: postTimestamp,
                        timestamp_iso: convertToISO(postTimestamp),
                        post_url: postUrl,
                        share_url: "N/A",
                        content_text: contentText,
                        image_url: "N/A",
                        video_url: "N/A",
                        image_source: "N/A",
                        video_source: "N/A",
                        reactions_total: reactions_total,
                        comments: comments,
                        shares: shares,
                        views: 0,
                        account_scraped: accountUrl, // ✅ Pakai accountUrl dari parameter function
                        scraped_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    };
                    
                    allScrapedUrls.add(postUrl);
                    if (postId) allScrapedUrls.add(`postid:${postId}`);
                    
                    postsData.push(post);

                    // ✅ ========== NEW: EXTRACT SNA RELATIONS ==========
                    if (CONFIG.ENABLE_SNA) {
                        try {
                            // Extract SNA from POST
                            const postSNA = extractSNAFromPost(post);
                            allSNARelations.push(...postSNA);
                            
                            // Extract SNA from COMMENTS (if available)
                            if (comment_details && comment_details.length > 0) {
                                const commentsSNA = extractSNAFromComments(
                                    comment_details,
                                    authorName,
                                    postUrl
                                );
                                allSNARelations.push(...commentsSNA);
                            }
                            
                            console.log(`      📊 SNA: +${postSNA.length + (comment_details ? extractSNAFromComments(comment_details, authorName, postUrl).length : 0)} relations`);
                            
                        } catch (snaError) {
                            console.warn(`      ⚠️ SNA extraction error: ${snaError.message}`);
                        }
                    }
                    // ✅ ========== END SNA EXTRACTION ==========
                    
                    console.log(`   ✅ [${postsData.length}/${maxPosts}] ${authorName.substring(0, 30)}`);

                    // ✅ Save progress after each successful post
                    const accountIndex = CONFIG.account_urls.indexOf(accountUrl);
                    saveProgress(accountIndex, i, accountUrl);
                    
                    // ✅ DEBUG PAUSE
                    await debugPause(`Post #${i + 1} extraction complete! Progress: ${postsData.length}/${maxPosts}`);
                    
                    await page.waitForTimeout(500 + Math.random() * 500);
                    
                } catch (error) {
                    skipReasons.otherErrors++;
                    console.warn(`      ❌ ERROR: ${error.message}`);
                }
            }
            
            // ========== E. BREAK IF DONE ==========
            if (postsData.length >= maxPosts) {
                console.log(`\n   🎯 Target reached!`);
                break;
            }
            
            // ========== F. SCROLL TO LOAD MORE ==========
            if (postIndex >= allPosts.length) {
                console.log(`\n📜 Scrolling... (${postsData.length}/${maxPosts})`);
                
                try {
                    const lastPost = allPosts[allPosts.length - 1];
                    await lastPost.scrollIntoViewIfNeeded().catch(() => {});
                    await page.waitForTimeout(1500);
                    await page.evaluate(() => window.scrollBy(0, 600));
                    await page.waitForTimeout(2000);
                } catch (scrollErr) {
                    console.warn(`   ⚠️ Scroll error`);
                    noNewPostsCount++;
                }
            }
            
            // ========== G. CHECK IF STUCK ==========
            if (scrollCycleUrls.size === 0) {
                noNewPostsCount++;
            } else {
                const allSame = [...scrollCycleUrls].every(url => currentScrollUrls.has(url));
                if (allSame) {
                    noNewPostsCount++;
                    console.log(`   ⚠️ Same posts (${noNewPostsCount}/${MAX_NO_NEW_POSTS})`);
                } else {
                    noNewPostsCount = 0;
                    currentScrollUrls = new Set(scrollCycleUrls);
                }
            }
        }
    } catch (error) {
        const accountName = accountUrl.split('/').pop(); // Extract account name
        console.error`❌ Error scraping account "${accountName}": ${error.message}`;
        await page.screenshot({ path: `error_screenshot_${accountName}_${Date.now()}.png` }).catch(() => {});
    }

    const totalInspected = postsData.length + Object.values(skipReasons).reduce((a, b) => a + b, 0);
    const accountName = accountUrl.split('/').pop(); // Extract account name
    
    console.log`\n📊 SCRAPING SUMMARY for "${accountName}":`;
    console.log`   ✅ Data scraped: ${postsData.length}`;
    console.log`   📋 Skip breakdown:`;
    console.log`      • Already in DB: ${skipReasons.alreadyScraped}`;
    console.log`      • No valid link: ${skipReasons.noValidLink}`;
    console.log`      • Invalid timestamp: ${skipReasons.invalidTimestamp}`;
    console.log`      • Invalid URL: ${skipReasons.invalidUrl}`;
    console.log`      • Detached element: ${skipReasons.detachedElement}`;
    console.log`      • Profile/suggestion cards: ${skipReasons.profileCard}`;
    console.log`      • People suggestions: ${skipReasons.peopleCard}`;
    console.log`      • Sponsored posts: ${skipReasons.sponsored}`;
    console.log`      • Empty elements: ${skipReasons.emptyContent}`;
    console.log`      • Other errors: ${skipReasons.otherErrors}`;
    console.log`   📈 Total posts inspected: ${totalInspected}`;
    
    const csvFilename = getCSVFilename(null); // Always use recent_posts.csv
    console.log`\n💾 Menyimpan ${postsData.length} data ke: ${csvFilename}...`;
    await saveData(postsData, csvFilename);

    // ✅ ========== NEW: SAVE SNA RELATIONS ==========
    if (CONFIG.ENABLE_SNA && allSNARelations.length > 0) {
        console.log(`\n🔗 Menyimpan ${allSNARelations.length} relasi SNA...`);
        await saveSNAToExcel(allSNARelations, CONFIG.SNA_FILENAME);
    }
    // ✅ ========== END SNA SAVE ==========

    // ✅ Update counter & save report
    totalPostsProcessed += postsData.length;
    saveStrategyReport(); // Auto-save setiap selesai scrape query

    return postsData.length;
}

/**
 * ✅ FIXED: Save data dengan UTF-8 encoding + BOM + PROPER CSV ESCAPING
 */
async function saveData(posts, postFile) {
    if (posts.length > 0) {
        const fileExists = fs.existsSync(postFile);
        
        // Write BOM untuk Excel compatibility
        if (!fileExists) {
            fs.writeFileSync(postFile, '\ufeff');
        }
        
        const postWriter = createObjectCsvWriter({
            path: postFile,
            header: [
                {id: 'author', title: 'author'},
                {id: 'location', title: 'location'},
                {id: 'timestamp', title: 'timestamp'},
                {id: 'timestamp_iso', title: 'timestamp_iso'},
                {id: 'post_url', title: 'post_url'},
                {id: 'share_url', title: 'share_url'},
                {id: 'content_text', title: 'content_text'},
                {id: 'image_url', title: 'image_url'},
                {id: 'video_url', title: 'video_url'},
                {id: 'image_source', title: 'image_source'},
                {id: 'video_source', title: 'video_source'},
                {id: 'reactions_total', title: 'reactions_total'},
                {id: 'comments', title: 'comments'},
                {id: 'shares', title: 'shares'},
                {id: 'views', title: 'views'},
                {id: 'comment_details', title: 'comment_details'},
                {id: 'account_scraped', title: 'account_scraped'}, // ✅ RENAMED
                {id: 'scraped_at', title: 'scraped_at'},
                {id: 'updated_at', title: 'updated_at'}
            ],
            append: fileExists,
            alwaysQuote: true,
            encoding: 'utf8',
            fieldDelimiter: ',',
        });
        
        await postWriter.writeRecords(posts);
        fs.chmodSync(postFile, CONFIG.FILE_PERMISSIONS);
        
        console.log(`✅ Data disimpan ke ${postFile}. Total: ${posts.length} posts`);
        log('INFO', `Data saved to ${postFile}`, { count: posts.length });
    }
}

/**
 * ✅ SIMPLIFIED: Update Engagement - DIRECT OVERWRITE
 */
async function updateEngagement(page, batchSize) {
    console.log(`\n🔄 UPDATE ENGAGEMENT - Direct overwrite mode`);
    
    const csvFiles = [];
    
    // Collect all CSV files
    for (const year of CONFIG.FILTER_YEARS) {
        const filename = getCSVFilename(year);
        if (fs.existsSync(filename)) {
            csvFiles.push(filename);
        }
    }
    
    const recentFile = getCSVFilename(null);
    if (fs.existsSync(recentFile)) {
        csvFiles.push(recentFile);
    }
    
    if (csvFiles.length === 0) {
        console.log("ℹ️ Tidak ada CSV untuk update engagement.");
        return;
    }
    
    console.log(`   Found ${csvFiles.length} CSV files to update`);
    
    // ✅ Create error folder
    const errorFolder = './update_errors';
    if (!fs.existsSync(errorFolder)) {
        fs.mkdirSync(errorFolder, { recursive: true });
    }
    
    for (const csvFile of csvFiles) {
        console.log(`\n   📂 Processing: ${csvFile}`);
        
        await new Promise((resolve) => {
            const posts = [];
            
            fs.createReadStream(csvFile)
                .pipe(csvParser())
                .on('data', (row) => posts.push(row))
                .on('end', async () => {
                    if (posts.length === 0) {
                        console.log("      ℹ️ No data to update");
                        resolve();
                        return;
                    }
                    
                    console.log(`      Total posts in file: ${posts.length}`);
                    
                    // ✅ Randomize
                    posts.sort(() => Math.random() - 0.5);
                    
                    // ✅ Take sample
                    const sampleToUpdate = posts.slice(0, batchSize);
                    console.log(`      -> Will update: ${sampleToUpdate.length} posts\n`);
                    
                    let updatedCount = 0;
                    let skippedCount = 0;
                    let noShareUrlCount = 0;
                    
                    for (let i = 0; i < sampleToUpdate.length; i++) {
                        const post = sampleToUpdate[i];
                        let updateUrl = null;
                        
                        try {
                            console.log(`      [${i + 1}/${sampleToUpdate.length}] 🔄 ${post.author || 'Unknown'}`);
                            
                            // ========== STEP 1: DETERMINE URL TO USE ==========
                            // Priority 1: share_url
                            if (post.share_url && post.share_url !== "N/A" && post.share_url.includes('facebook.com')) {
                                updateUrl = post.share_url;
                                console.log(`         -> Using share_url`);
                            }
                            // Priority 2: post_url
                            else if (post.post_url && post.post_url !== "N/A") {
                                updateUrl = post.post_url;
                                console.log(`         -> Using post_url (no share_url available)`);
                                noShareUrlCount++;
                            }
                            // Priority 3: Skip (no valid URL)
                            else {
                                console.log(`         ❌ No valid URL - skipping`);
                                skippedCount++;
                                continue;
                            }
                            
                            console.log(`         -> Opening: ${updateUrl.substring(0, 80)}...`);
                            
                            // ========== STEP 2: OPEN PAGE ==========
                            const gotoResult = await page.goto(updateUrl, { 
                                waitUntil: 'domcontentloaded', 
                                timeout: 30000 
                            }).catch((err) => {
                                console.warn(`         ⚠️ Page load error: ${err.message.substring(0, 40)}`);
                                return null;
                            });
                            
                            if (!gotoResult) {
                                skippedCount++;
                                continue;
                            }
                            
                            await page.waitForTimeout(4000);
                            await page.waitForSelector('div[role="main"]', { timeout: 10000 }).catch(() => {});
                            await page.waitForTimeout(2000);
                            
                            // ========== STEP 3: EXTRACT ENGAGEMENT (SIMPLE) ==========
                            let reactions_total = 0;
                            let comments = 0;
                            let shares = 0;
                            
                            const oldReactions = parseInt(post.reactions_total) || 0;
                            const oldComments = parseInt(post.comments) || 0;
                            const oldShares = parseInt(post.shares) || 0;
                            
                            // --- REACTIONS ---
                            try {
                                // Try multiple selectors
                                const reactionSelectors = [
                                    'div[aria-label="Like"][role="button"] span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6.xlyipyv.xuxw1ft.x1j85h84',
                                    'span.xt0b8zv span.html-span.xdj266r',
                                    'div:has-text("All reactions:") span.xt0b8zv',
                                    'div:has-text("All reactions:") span',
                                    'span[aria-label*="reaction"]'
                                ];
                                
                                for (const selector of reactionSelectors) {
                                    const el = await page.locator(selector).first();
                                    if (await el.count() > 0) {
                                        const text = await el.textContent().catch(() => '') || 
                                                    await el.getAttribute('aria-label').catch(() => '');
                                        
                                        if (text && text.match(/\d/)) {
                                            reactions_total = parseEngagementCount(text);
                                            if (reactions_total > 0) break;
                                        }
                                    }
                                }
                            } catch (e) {}
                            
                            // --- COMMENTS ---
                            try {
                                const commentSelectors = [
                                    'div[aria-label="Comment"][role="button"] span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6.xlyipyv.xuxw1ft.x1j85h84',
                                    'span.html-span.xkrqix3.x1sur9pj:has-text("comment")',
                                    'span:has-text("comment")'
                                ];
                                
                                for (const selector of commentSelectors) {
                                    const elements = await page.locator(selector).all();
                                    
                                    for (const el of elements) {
                                        const text = await el.textContent().catch(() => '');
                                        
                                        if (text && text.toLowerCase().includes('comment')) {
                                            const match = text.match(/(\d+[\d,.]*(K|k|M|m)?)\s*comment/i);
                                            if (match) {
                                                comments = parseEngagementCount(match[1]);
                                                if (comments > 0) break;
                                            }
                                        }
                                    }
                                    
                                    if (comments > 0) break;
                                }
                            } catch (e) {}
                            
                            // --- SHARES ---
                            try {
                                const shareSelectors = [
                                    'div[aria-label="Share"][role="button"] span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6.xlyipyv.xuxw1ft.x1j85h84',
                                    'div[aria-label="Send"][role="button"] span.x1lliihq',
                                    'span.html-span.xkrqix3.x1sur9pj:has-text("share")',
                                    'span:has-text("share")'
                                ];
                                
                                for (const selector of shareSelectors) {
                                    const elements = await page.locator(selector).all();
                                    
                                    for (const el of elements) {
                                        const text = await el.textContent().catch(() => '');
                                        
                                        if (text && text.toLowerCase().includes('share')) {
                                            const match = text.match(/(\d+[\d,.]*(K|k|M|m)?)\s*share/i);
                                            if (match) {
                                                shares = parseEngagementCount(match[1]);
                                                if (shares > 0) break;
                                            }
                                        }
                                    }
                                    
                                    if (shares > 0) break;
                                }
                            } catch (e) {}
                            
                            // ========== STEP 4: IF NO SHARE_URL, TRY TO EXTRACT IT ==========
                            if (post.share_url === "N/A" || !post.share_url) {
                                console.log(`         -> No share_url, trying to extract...`);
                                
                                try {
                                    // Find Share button
                                    const shareButton = await page.locator(
                                        'div[aria-label="Send this to friends or post it on your profile."][role="button"], ' +
                                        'div[aria-label*="Share"][role="button"]'
                                    ).first();
                                    
                                    if (await shareButton.count() > 0) {
                                        await shareButton.scrollIntoViewIfNeeded().catch(() => {});
                                        await page.waitForTimeout(500);
                                        await shareButton.click({ timeout: 5000 });
                                        await page.waitForTimeout(2500);
                                        
                                        // Find Copy link
                                        const copyLinkButton = await page.locator(
                                            'div[role="button"]:has(span:has-text("Copy link"))'
                                        ).first();
                                        
                                        if (await copyLinkButton.count() > 0) {
                                            // Clear clipboard
                                            await page.evaluate(() => navigator.clipboard.writeText('')).catch(() => {});
                                            await page.waitForTimeout(300);
                                            
                                            // Click Copy link
                                            await copyLinkButton.click({ timeout: 3000 });
                                            await page.waitForTimeout(1000);
                                            
                                            // Read clipboard
                                            const clipboardContent = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
                                            
                                            if (clipboardContent && clipboardContent.includes('facebook.com')) {
                                                post.share_url = clipboardContent;
                                                console.log(`         ✅ Extracted share_url: ${clipboardContent.substring(0, 60)}...`);
                                            }
                                        }
                                        
                                        // Close dialog
                                        await page.keyboard.press('Escape');
                                        await page.waitForTimeout(500);
                                    }
                                } catch (extractError) {
                                    console.log(`         ⚠️ Could not extract share_url: ${extractError.message.substring(0, 40)}`);
                                }
                            }
                            
                            // ========== STEP 5: VALIDATION ==========
                            // ✅ If extraction got 0 but old value exists, keep old
                            if (reactions_total === 0 && oldReactions > 0) {
                                console.log(`         ⚠️ Reactions extraction failed (${oldReactions} → 0), keeping old`);
                                reactions_total = oldReactions;
                            }
                            
                            if (comments === 0 && oldComments > 0) {
                                console.log(`         ⚠️ Comments extraction failed (${oldComments} → 0), keeping old`);
                                comments = oldComments;
                            }
                            
                            if (shares === 0 && oldShares > 0) {
                                console.log(`         ⚠️ Shares extraction failed (${oldShares} → 0), keeping old`);
                                shares = oldShares;
                            }
                            
                            // ✅ Check if anything changed
                            const hasChanges = 
                                reactions_total !== oldReactions || 
                                comments !== oldComments || 
                                shares !== oldShares ||
                                (post.share_url !== "N/A" && post.share_url !== row.share_url);
                            
                            if (!hasChanges) {
                                console.log(`         ℹ️  No changes detected - skipping`);
                                skippedCount++;
                                continue;
                            }
                            
                            // ========== STEP 6: UPDATE POST DATA ==========
                            post.reactions_total = reactions_total;
                            post.comments = comments;
                            post.shares = shares;
                            post.updated_at = new Date().toISOString();
                            
                            updatedCount++;
                            
                            const deltaR = reactions_total - oldReactions;
                            const deltaC = comments - oldComments;
                            const deltaS = shares - oldShares;
                            
                            const formatDelta = (delta) => delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '±0';
                            console.log(`         ✅ R:${reactions_total} (${formatDelta(deltaR)}) C:${comments} (${formatDelta(deltaC)}) S:${shares} (${formatDelta(deltaS)})`);
                            
                            // Human-like delay
                            await page.waitForTimeout(3000 + Math.random() * 2000);
                            
                        } catch (error) {
                            console.warn(`         ⚠️ Error processing post: ${error.message.substring(0, 50)}`);
                            skippedCount++;
                            
                            // ✅ SAVE ERROR HTML
                            try {
                                const timestamp = Date.now();
                                const errorHtmlFile = path.join(errorFolder, `error_update_${i + 1}_${timestamp}.html`);
                                
                                const pageContent = await page.content().catch(() => '<html><body>Could not get page content</body></html>');
                                
                                const errorData = {
                                    timestamp: new Date().toISOString(),
                                    post_author: post.author,
                                    post_url: post.post_url,
                                    share_url: post.share_url,
                                    update_url: updateUrl,
                                    error_message: error.message,
                                    error_stack: error.stack
                                };
                                
                                const fullHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Error Update Post - ${post.author}</title>
    <style>
        .error-info { 
            background: #fee; 
            padding: 20px; 
            margin: 20px; 
            border: 2px solid #c00;
            font-family: monospace;
        }
        .error-info h2 { color: #c00; }
        .error-info pre { background: #fff; padding: 10px; overflow-x: auto; }
    </style>
</head>
<body>
    <div class="error-info">
        <h2>❌ Update Error</h2>
        <p><strong>Timestamp:</strong> ${errorData.timestamp}</p>
        <p><strong>Author:</strong> ${errorData.post_author}</p>
        <p><strong>Post URL:</strong> <a href="${errorData.post_url}">${errorData.post_url}</a></p>
        <p><strong>Share URL:</strong> <a href="${errorData.share_url}">${errorData.share_url}</a></p>
        <p><strong>Update URL Used:</strong> <a href="${errorData.update_url}">${errorData.update_url}</a></p>
        <p><strong>Error:</strong></p>
        <pre>${errorData.error_message}</pre>
        <p><strong>Stack:</strong></p>
        <pre>${errorData.error_stack}</pre>
    </div>
    <hr>
    <h2>Page Content (for debugging):</h2>
    ${pageContent}
</body>
</html>
`;
                                
                                fs.writeFileSync(errorHtmlFile, fullHtml);
                                fs.chmodSync(errorHtmlFile, CONFIG.FILE_PERMISSIONS);
                                
                                console.log(`         📁 Error HTML saved: ${errorHtmlFile}`);
                                
                            } catch (saveError) {
                                console.error(`         ❌ Could not save error HTML: ${saveError.message}`);
                            }
                        }
                    }
                    
                    // ========== SAVE UPDATED DATA ==========
                    if (updatedCount > 0) {
                        console.log(`\n      💾 Saving ${updatedCount} updated posts...`);
                        
                        const writer = createObjectCsvWriter({
                            path: csvFile,
                            header: Object.keys(posts[0]).map(id => ({id, title: id})),
                            alwaysQuote: true,
                            encoding: 'utf8',
                            fieldDelimiter: ','
                        });
                        
                        await writer.writeRecords(posts);
                        fs.chmodSync(csvFile, CONFIG.FILE_PERMISSIONS);
                        
                        console.log(`      ✅ ${updatedCount} posts updated in ${csvFile}`);
                        log('INFO', 'Engagement updated', {
                            file: csvFile,
                            updated: updatedCount,
                            skipped: skippedCount,
                            no_share_url: noShareUrlCount
                        });
                    }
                    
                    console.log(`\n      📊 Summary:`);
                    console.log(`         • Updated: ${updatedCount}`);
                    console.log(`         • Skipped: ${skippedCount}`);
                    console.log(`         • Posts without share_url: ${noShareUrlCount}`);
                    
                    resolve();
                });
        });
    }
    
    console.log(`\n✅ Update engagement completed!`);
}


/**
 * ✅ NEW: Update Video Views from individual video pages
 */
async function updateVideoViews(page, batchSize) {
    console.log(`\n🎬 UPDATE VIDEO VIEWS - Opening video pages...`);
    
    const csvFiles = [];
    
    // Collect all CSV files
    for (const year of CONFIG.FILTER_YEARS) {
        const filename = getCSVFilename(year);
        if (fs.existsSync(filename)) {
            csvFiles.push(filename);
        }
    }
    
    const recentFile = getCSVFilename(null);
    if (fs.existsSync(recentFile)) {
        csvFiles.push(recentFile);
    }
    
    if (csvFiles.length === 0) {
        console.log("ℹ️ Tidak ada CSV untuk update views.");
        return;
    }
    
    console.log(`   Found ${csvFiles.length} CSV files to update`);
    
    for (const csvFile of csvFiles) {
        console.log(`\n   📂 Processing: ${csvFile}`);
        
        await new Promise((resolve) => {
            const posts = [];
            
            fs.createReadStream(csvFile)
                .pipe(csvParser())
                .on('data', (row) => posts.push(row))
                .on('end', async () => {
                    if (posts.length === 0) {
                        console.log("      ℹ️ No data to update");
                        resolve();
                        return;
                    }

                    console.log(`      Total posts in file: ${posts.length}`);

                    // ✅ FILTER: Only posts with video
                    const postsWithVideo = posts.filter(p => {
                        const hasVideoUrl = p.video_url && p.video_url !== "N/A";
                        const hasVideoInShareUrl = p.share_url && 
                            p.share_url !== "N/A" && 
                            (p.share_url.includes('/videos/') || 
                             p.share_url.includes('/watch/') || 
                             p.share_url.includes('/reel/'));
                        
                        return hasVideoUrl || hasVideoInShareUrl;
                    });
                    
                    const postsWithoutVideo = posts.length - postsWithVideo.length;

                    console.log(`      • Posts dengan video: ${postsWithVideo.length}`);
                    console.log(`      • Posts tanpa video: ${postsWithoutVideo} (will skip)`);

                    if (postsWithVideo.length === 0) {
                        console.log("      ℹ️ No video posts to update");
                        resolve();
                        return;
                    }

                    // ✅ Randomize untuk variasi
                    postsWithVideo.sort(() => Math.random() - 0.5);

                    // ✅ Ambil sample sesuai batchSize
                    const sampleToUpdate = postsWithVideo.slice(0, batchSize);

                    console.log(`      -> Will update: ${sampleToUpdate.length} video posts\n`);

                    let updatedCount = 0;
                    let skippedCount = 0;

                    for (let i = 0; i < sampleToUpdate.length; i++) {
                        const post = sampleToUpdate[i];
                        
                        try {
                            // Determine which URL to use (prefer video_url)
                            let videoPageUrl = null;
                            
                            if (post.video_url && post.video_url !== "N/A") {
                                videoPageUrl = post.video_url;
                            } else if (post.share_url && post.share_url !== "N/A" && 
                                      (post.share_url.includes('/videos/') || 
                                       post.share_url.includes('/watch/') || 
                                       post.share_url.includes('/reel/'))) {
                                videoPageUrl = post.share_url;
                            }
                            
                            if (!videoPageUrl) {
                                console.log(`      [${i + 1}/${sampleToUpdate.length}] ⏭️  Skipped: No valid video URL`);
                                skippedCount++;
                                continue;
                            }
                            
                            console.log(`      [${i + 1}/${sampleToUpdate.length}] 🎬 ${post.author || 'Unknown'}`);
                            console.log(`         -> Opening: ${videoPageUrl.substring(0, 80)}...`);
                            
                            // ========== OPEN VIDEO URL ==========
                            const gotoResult = await page.goto(videoPageUrl, { 
                                waitUntil: 'domcontentloaded', 
                                timeout: 30000 
                            }).catch((err) => {
                                console.warn(`         ⚠️ Page load error: ${err.message.substring(0, 40)}`);
                                return null;
                            });
                            
                            if (!gotoResult) {
                                skippedCount++;
                                continue;
                            }
                            
                            // Wait for page to fully load
                            await page.waitForTimeout(4000);

                            // ========== WAIT FOR VIDEO PLAYER ==========
                            await page.waitForSelector('video, div[role="main"]', { timeout: 10000 }).catch(() => {
                                console.log(`         ⚠️ Video player not found`);
                            });
                            
                            await page.waitForTimeout(2000);

                            const oldViews = parseInt(post.views) || 0;
                            let views = 0;

                            // ========== EXTRACT VIEWS ==========
                            try {
                                // Strategy 1: Exact selector from HTML (priority)
                                const viewsSelectors = [
                                    // Primary: Exact match dari HTML yang Anda berikan
                                    'span._26fq span.x193iq5w:has-text("views")',
                                    'span._26fq span:has-text("views")',
                                    // Secondary: Class variations
                                    'span.html-span.xkrqix3.x1sur9pj:has-text("views")',
                                    'span.html-span:has-text("views")',
                                    // Tertiary: Broader search
                                    'span.x193iq5w.xeuugli:has-text("views")',
                                    'span.x193iq5w:has-text("views")',
                                    'span:has-text("views")',
                                    'div:has-text("views")',
                                ];
                                
                                for (const selector of viewsSelectors) {
                                    const viewSpans = await page.locator(selector).all();
                                    
                                    for (const span of viewSpans) {
                                        const text = await span.textContent();
                                        
                                        if (text && text.toLowerCase().includes('view')) {
                                            // Pattern: "2.4M views" or "38K views" or "500 views"
                                            const match = text.match(/(\d+[\d,.]*(K|k|M|m|rb|Rb|jt|Jt)?)\s*views?/i);
                                            
                                            if (match) {
                                                views = parseEngagementCount(match[1]);
                                                
                                                if (views > 0) {
                                                    console.log(`         ✅ Views extracted: ${views} (${match[0]})`);
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    
                                    if (views > 0) break;
                                }
                                
                                // Strategy 2: Search all text content (fallback)
                                if (views === 0) {
                                    console.log(`         -> Trying fallback: all text search...`);
                                    
                                    const allTexts = await page.locator('span, div').allTextContents();
                                    
                                    for (const text of allTexts) {
                                        if (!text) continue;
                                        
                                        const match = text.match(/(\d+[\d,.]*(K|k|M|m|rb|Rb|jt|Jt)?)\s*views?/i);
                                        if (match) {
                                            views = parseEngagementCount(match[1]);
                                            if (views > 0) {
                                                console.log(`         ✅ Views extracted (fallback): ${views} (${text.trim()})`);
                                                break;
                                            }
                                        }
                                    }
                                }
                                
                            } catch (e) {
                                console.warn(`         ⚠️ Views extraction error: ${e.message.substring(0, 40)}`);
                            }

                            // ========== VALIDATION - ENHANCED ==========
                            // ✅ Check: Jangan update kalau old > 0 tapi new = 0 (extraction failed)
                            const extractionFailed = oldViews > 0 && views === 0;

                            if (views === 0 || extractionFailed) {
                                if (extractionFailed) {
                                    console.log(`         ⚠️ Extraction failed: ${oldViews} → 0 ❌ (keeping old: ${oldViews})`);
                                } else {
                                    console.log(`         ⚠️ Views not found - keeping old value (${oldViews})`);
                                }
                                
                                skippedCount++;
                                
                                // ✅ DEBUG: Save screenshot untuk analisis
                                if (CONFIG.SCREENSHOT_ON_ERROR) {
                                    const filename = await captureErrorScreenshot(page, 'no_views', i + 1);
                                    if (filename) {
                                        console.log(`         📸 Screenshot: ${filename}`);
                                    }
                                }
                                
                                continue;  // ✅ SKIP, jangan update!
                            }

                            // ========== UPDATE POST DATA ==========
                            const deltaV = views - oldViews;
                            const formatDelta = (delta) => delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '±0';

                            post.views = views;
                            post.updated_at = new Date().toISOString();
                            
                            updatedCount++;
                            
                            console.log(`         ✅ V:${views} (${formatDelta(deltaV)})`);

                            // ✅ Human-like delay (3-5 detik)
                            await page.waitForTimeout(3000 + Math.random() * 2000);
                            
                        } catch (error) {
                            console.warn(`         ⚠️ Error processing video: ${error.message.substring(0, 50)}`);
                            skippedCount++;
                            
                            // Screenshot on error
                            if (CONFIG.SCREENSHOT_ON_ERROR) {
                                await captureErrorScreenshot(page, 'update_views', i + 1);
                            }
                        }
                    }

                    // ========== SAVE UPDATED DATA ==========
                    if (updatedCount > 0) {
                        console.log(`\n      💾 Saving ${updatedCount} updated posts...`);
                        
                        const writer = createObjectCsvWriter({
                            path: csvFile,
                            header: Object.keys(posts[0]).map(id => ({id, title: id})),
                            alwaysQuote: true,
                            encoding: 'utf8'
                        });
                        
                        await writer.writeRecords(posts);
                        
                        // Set file permissions
                        fs.chmodSync(csvFile, CONFIG.FILE_PERMISSIONS);
                        
                        console.log(`      ✅ ${updatedCount} video views updated in ${csvFile}`);
                        
                        log('INFO', 'Video views updated', {
                            file: csvFile,
                            updated: updatedCount,
                            skipped: skippedCount
                        });
                    }
                    
                    console.log(`      ℹ️ Skipped: ${skippedCount} videos (no views found or error)`);

                    resolve();
                });
        });
    }
    
    console.log(`\n✅ Update video views completed!`);
}


// ======== 📊 SNA (SOCIAL NETWORK ANALYSIS) FUNCTIONS ========

/**
 * ✅ Extract SNA relations dari POST
 * @param {Object} post - Post data object
 * @returns {Array} Array of SNA relation objects
 */
function extractSNAFromPost(post) {
    const relations = [];
    
    if (!post || !post.author) return relations;
    
    const postAuthor = post.author;
    const postUrl = post.share_url !== "N/A" ? post.share_url : post.post_url;
    const timestamp = post.timestamp_iso || post.timestamp;
    
    // ========== 1. HASHTAG RELATIONS ==========
    if (CONFIG.SNA_RELATIONS.hashtag && post.content_text) {
        const hashtags = post.content_text.match(/#[\w\u0080-\uFFFF]+/g);
        
        if (hashtags) {
            hashtags.forEach(hashtag => {
                relations.push({
                    source: postAuthor,
                    target: hashtag,
                    relation: 'hashtag_use',
                    post_url: postUrl,
                    timestamp: timestamp,
                    context: 'post_content'
                });
            });
        }
    }
    
    // ========== 2. MENTION RELATIONS ==========
    if (CONFIG.SNA_RELATIONS.mention && post.content_text) {
        const mentions = post.content_text.match(/@[\w.]+/g);
        
        if (mentions) {
            mentions.forEach(mentioned => {
                // Check if self-mention
                const isSelfMention = mentioned.toLowerCase() === postAuthor.toLowerCase();
                
                relations.push({
                    source: postAuthor,
                    target: mentioned,
                    relation: isSelfMention ? 'self_mention' : 'mention',
                    post_url: postUrl,
                    timestamp: timestamp,
                    context: 'post_content'
                });
            });
        }
    }
    
    // ========== 3. AUTHOR-POST RELATION ==========
    // Track who posted what
    relations.push({
        source: postAuthor,
        target: postUrl,
        relation: 'post',
        post_url: postUrl,
        timestamp: timestamp,
        context: 'authorship'
    });
    
    return relations;
}

/**
 * ✅ Extract SNA relations dari COMMENTS
 * @param {Array} comments - Array of comment objects
 * @param {string} postAuthor - Author of the post
 * @param {string} postUrl - URL of the post
 * @returns {Array} Array of SNA relation objects
 */
function extractSNAFromComments(comments, postAuthor, postUrl) {
    const relations = [];
    
    if (!comments || comments.length === 0) return relations;
    
    comments.forEach(comment => {
        const commenter = comment.comment_author;
        const commentText = comment.comment_text;
        const commentTimestamp = comment.comment_timestamp;
        
        if (!commenter || commenter === 'Unknown') return;
        
        // ========== 1. COMMENT RELATION (commenter → post author) ==========
        if (CONFIG.SNA_RELATIONS.comment) {
            relations.push({
                source: commenter,
                target: postAuthor,
                relation: 'comment',
                post_url: postUrl,
                timestamp: commentTimestamp,
                context: 'comment_on_post'
            });
        }
        
        // ========== 2. HASHTAG IN COMMENTS ==========
        if (CONFIG.SNA_RELATIONS.hashtag && commentText) {
            const hashtags = commentText.match(/#[\w\u0080-\uFFFF]+/g);
            
            if (hashtags) {
                hashtags.forEach(hashtag => {
                    relations.push({
                        source: commenter,
                        target: hashtag,
                        relation: 'hashtag_use_in_comment',
                        post_url: postUrl,
                        timestamp: commentTimestamp,
                        context: 'comment_content'
                    });
                });
            }
        }
        
        // ========== 3. MENTION IN COMMENTS ==========
        if (CONFIG.SNA_RELATIONS.mention && commentText) {
            const mentions = commentText.match(/@[\w.]+/g);
            
            if (mentions) {
                mentions.forEach(mentioned => {
                    const isSelfMention = mentioned.toLowerCase() === commenter.toLowerCase();
                    
                    relations.push({
                        source: commenter,
                        target: mentioned,
                        relation: isSelfMention ? 'self_mention_in_comment' : 'mention_in_comment',
                        post_url: postUrl,
                        timestamp: commentTimestamp,
                        context: 'comment_content'
                    });
                });
            }
        }
    });
    
    return relations;
}

/**
 * ✅ Save SNA relations to XLSX file
 * @param {Array} relations - Array of SNA relation objects
 * @param {string} filename - Output filename
 */
async function saveSNAToExcel(relations, filename) {
    if (!relations || relations.length === 0) {
        console.log("ℹ️  No SNA relations to save");
        return;
    }
    
    try {
        const outputPath = path.join(CONFIG.csv_base_folder, filename);
        
        // Check if file exists
        const fileExists = fs.existsSync(outputPath);
        
        if (fileExists) {
            // ========== APPEND MODE: Read existing + merge ==========
            console.log(`📂 Loading existing SNA file: ${filename}`);
            
            const existingRelations = [];
            
            await new Promise((resolve) => {
                fs.createReadStream(outputPath)
                    .pipe(csvParser())
                    .on('data', (row) => existingRelations.push(row))
                    .on('end', resolve);
            });
            
            console.log(`   ✓ Loaded ${existingRelations.length} existing relations`);
            
            // Merge new relations
            const allRelations = [...existingRelations, ...relations];
            
            // Remove duplicates based on unique key
            const uniqueRelations = [];
            const seenKeys = new Set();
            
            allRelations.forEach(rel => {
                const key = `${rel.source}|${rel.target}|${rel.relation}|${rel.post_url}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    uniqueRelations.push(rel);
                }
            });
            
            console.log(`   ✓ After deduplication: ${uniqueRelations.length} unique relations`);
            console.log(`   ✓ New relations added: ${uniqueRelations.length - existingRelations.length}`);
            
            // Save to XLSX
            const csv = new ObjectsToCsv(uniqueRelations);
            await csv.toDisk(outputPath);
            
        } else {
            // ========== NEW FILE MODE ==========
            console.log(`📄 Creating new SNA file: ${filename}`);
            
            const csv = new ObjectsToCsv(relations);
            await csv.toDisk(outputPath);
            
            console.log(`   ✓ Created with ${relations.length} relations`);
        }
        
        // Set permissions
        fs.chmodSync(outputPath, CONFIG.FILE_PERMISSIONS);
        
        console.log(`✅ SNA relations saved to: ${outputPath}`);
        
        // ========== SHOW SUMMARY ==========
        const relationCounts = {};
        relations.forEach(rel => {
            relationCounts[rel.relation] = (relationCounts[rel.relation] || 0) + 1;
        });
        
        console.log("\n📊 SNA Relations Summary:");
        Object.entries(relationCounts)
            .sort((a, b) => b[1] - a[1])
            .forEach(([relation, count]) => {
                console.log(`   • ${relation}: ${count}`);
            });
        
    } catch (error) {
        console.error(`❌ Error saving SNA relations: ${error.message}`);
    }
}


/**
 * Main job runner
 */
async function runJob() {
    if (isJobRunning) {
        console.log(`\n🏃 Job sebelumnya masih berjalan. Skip...`);
        return;
    }
    isJobRunning = true;

    log('INFO', 'Job started', { 
        cycle: stats.cycleCount + 1,
        isFirstRun: !isFirstRunDone 
    });
    
    let totalScraped = 0;
    let totalErrors = 0;
    
    console.log(`\n${"=".repeat(70)}`);
    console.log(`🚀 [${new Date().toLocaleString('id-ID')}] MEMULAI SIKLUS SCRAPING`);
    console.log(`${"=".repeat(70)}`);
    
    const userDataDir = path.join(os.homedir(), 'playwright_fb_session');
    
    let context;
    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            channel: 'chrome',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            permissions: ['clipboard-read', 'clipboard-write'],
            viewport: { width: 1920, height: 1080 },
            args: [
                '--disable-blink-features=AutomationControlled',
                '--enable-clipboard-read-write'
            ]
        });
        
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { 
            origin: 'https://www.facebook.com' 
        });

        const page = await context.newPage();
        await page.goto("https://www.facebook.com/", { waitUntil: 'domcontentloaded' });
        
        let loginSuccess;
        try {
            await page.waitForSelector('a[aria-label="Home"]', { timeout: 5000 });
            console.log("🎉 Login sudah ada (dari sesi sebelumnya).");
            loginSuccess = true;
        } catch (e) {
            console.log("ℹ️ Belum login. Memulai proses login...");
            loginSuccess = await loginToFacebook(page, CONFIG.fb_username, CONFIG.fb_password);
        }

        if (!loginSuccess) {
            console.error("❌ Login gagal. Scraping dibatalkan.");
            isJobRunning = false;
            if (context) await context.close();
            return;
        }

        console.log("✅ Login sukses. Memulai scraping...\n");
        
        let totalScraped = 0;

        // ✅ Load progress untuk resume
        const progress = loadProgress();
        const startAccountIndex = progress.lastAccountIndex || 0;
        const startPostIndex = progress.lastPostIndex || 0;

        console.log(`\n📍 Resume point: Account #${startAccountIndex + 1}, Post #${startPostIndex + 1}\n`);

        // ✅ NEW: Loop through account URLs instead of queries
        for (let i = startAccountIndex; i < CONFIG.account_urls.length; i++) {  // ⬅️ UBAH DARI 0 KE startAccountIndex
            const accountUrl = CONFIG.account_urls[i];
            
            // ✅ Skip jika sebelum resume point
            if (i < startAccountIndex) {
                console.log(`⏭️  Skipping account #${i + 1} (already processed)`);
                continue;
            }
            
            const accountName = accountUrl.split('/').pop(); // Extract account name from URL
            
            console.log(`\n${"━".repeat(70)}`);
            console.log(`🎯 Account ${i + 1}/${CONFIG.account_urls.length}: ${accountName}`);
            console.log(`   URL: ${accountUrl}`);
            console.log(`${"━".repeat(70)}`);
            
            const accountPage = await context.newPage();
            
            try {
                // ✅ Direct scraping (NO search, NO filter)
                // Resume from last post if same account
                const resumeFrom = (i === startAccountIndex) ? startPostIndex : 0;
                const scraped = await scrapeAccountPosts(accountPage, accountUrl, CONFIG.max_posts_per_account, resumeFrom);
                totalScraped += scraped;
                
            } catch (pageError) {
                console.error(`❌ Error scraping ${accountName}: ${pageError.message}`);
                totalErrors++;
            } finally {
                if (!accountPage.isClosed()) {
                    await accountPage.close();
                }
            }
            
            // Jeda antar akun
            if (i < CONFIG.account_urls.length - 1) {
                const jeda = CONFIG.JEDA_ANTAR_QUERY_MENIT * 60 * 1000;
                console.log(`\n😴 Jeda ${CONFIG.JEDA_ANTAR_QUERY_MENIT} menit...`);
                await new Promise(resolve => setTimeout(resolve, jeda));
            }
        }
        

        // ✅ Reset progress setelah semua akun selesai
        resetProgress();
        console.log(`\n${"=".repeat(70)}`);
        console.log(`🎉 SCRAPING SELESAI - Total: ${totalScraped} posts baru`);
        console.log(`${"=".repeat(70)}`);
        // ✅ NEW: Update statistics
        updateStats(totalScraped, totalErrors);

        // ✅ Save strategy report setiap cycle
        saveStrategyReport();
        console.log("📊 Strategy report updated!\n");

        console.log("\n🔄 Memulai update engagement...");
        const updatePage = await context.newPage();
        try {
            // Update engagement (selalu jalan)
            await updateEngagement(updatePage, CONFIG.UPDATE_BATCH_SIZE);

            // ✅ NEW: Auto-update recent posts (refresh engagement + new comments)
            console.log("\n🔄 Auto-updating recent posts...");
            await autoUpdateRecentPosts(updatePage, 10); // Update 10 posts terakhir
            
            // ✅ NEW: Update video views (LESS FREQUENT - setiap 3 siklus sekali)
            // Ini untuk menghindari terlalu aggressive dan takut kena rate limit
            if (stats.cycleCount % 3 === 0) {
                console.log("\n🎬 Memulai update video views...");
                // Batch size lebih kecil (setengah dari engagement) untuk lebih aman
                await updateVideoViews(updatePage, Math.floor(CONFIG.UPDATE_BATCH_SIZE / 2));
            } else {
                console.log(`\n⏭️  Skipping video views update this cycle (will update every 3rd cycle, next in ${3 - (stats.cycleCount % 3)} cycle(s))`);
            }
            
        } catch (updateError) {
            console.error(`❌ Error update: ${updateError.message}`);
            log('ERROR', 'Update error', { error: updateError.message });
        } finally {
            await updatePage.close();
        }

    } catch (error) {
        console.error("❌ Error fatal:", error);
        log('ERROR', 'Fatal error in runJob', { 
            error: error.message,
            stack: error.stack?.substring(0, 500)
        });
        totalErrors++;
        stats.lastErrorTime = new Date().toISOString();
    } finally {
        if (context) {
            await context.close();
        }
        console.log("✅ Browser ditutup.\n");
        isJobRunning = false;
    }
}

/**
 * Main loop
 */
async function main() {
    console.log("\n");
    console.log("╔═══════════════════════════════════════════════════════════════════╗");
    console.log("║   🤖 FACEBOOK PROFILE SCRAPER v8.0 - FULL COMMENTS          ║");
    console.log("╠═══════════════════════════════════════════════════════════════════╣");
    console.log(`║  Target Accounts: ${CONFIG.account_urls.length}                                             ║`);
    console.log(`║  Max Posts/Account: ${CONFIG.max_posts_per_account}                                     ║`);
    console.log(`║  Extract Comments: ${CONFIG.EXTRACT_COMMENTS ? 'YES ✅' : 'NO'}                                    ║`);
    console.log(`║  CSV Folder: ${CONFIG.csv_base_folder}                                    ║`);
    console.log(`║  DEBUG MODE: ${CONFIG.DEBUG_MODE ? 'ON ✅' : 'OFF'}                                          ║`);
    console.log("╚═══════════════════════════════════════════════════════════════════╝");
    console.log();

    // ✅ BEST: Load existing URLs from ALL CSV files (flexible & safe)
    const allCsvFiles = [];
    
    // Check if csv folder exists
    if (fs.existsSync(CONFIG.csv_base_folder)) {
        // Find ALL CSV files in folder (support old year-based files too)
        const csvFilesInFolder = fs.readdirSync(CONFIG.csv_base_folder)
            .filter(f => f.endsWith('.csv'))
            .map(f => path.join(CONFIG.csv_base_folder, f));
        
        allCsvFiles.push(...csvFilesInFolder);
    }
    
    // Ensure main CSV is included
    const mainCsv = getCSVFilename(null); // recent_posts.csv
    if (!allCsvFiles.includes(mainCsv) && fs.existsSync(mainCsv)) {
        allCsvFiles.push(mainCsv);
    }
    
    console.log(`📂 Found ${allCsvFiles.length} CSV file(s)\n`);
    
    // Load URLs from all CSV files
    for (const csvFile of allCsvFiles) {
        await new Promise((resolve) => {
            let rowCount = 0;
            
            fs.createReadStream(csvFile)
                .pipe(csvParser())
                .on('data', (row) => {
                    if (row.post_url && row.post_url !== 'N/A') {
                        allScrapedUrls.add(row.post_url);
                        rowCount++;
                    }
                })
                .on('end', () => {
                    console.log(`   ✓ ${path.basename(csvFile)}: ${rowCount} URLs loaded`);
                    resolve();
                })
                .on('error', (err) => {
                    console.warn(`   ⚠️ Error reading ${path.basename(csvFile)}: ${err.message}`);
                    resolve(); // Continue even if error
                });
        });
    }
    
    console.log(`\n📊 Total existing URLs: ${allScrapedUrls.size}`);
    console.log(`   Duplicate posts will be skipped automatically\n`);
    
    // ✅ NEW: Setup periodic backup timer
    if (CONFIG.BACKUP_ENABLED) {
        setInterval(() => {
            createBackup();
        }, CONFIG.BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
        
        log('INFO', 'Backup timer started', { 
            interval: `${CONFIG.BACKUP_INTERVAL_HOURS} hours` 
        });
    }
    
    // ✅ NEW: Setup stats save timer
    setInterval(() => {
        saveStats();
    }, 5 * 60 * 1000); // Save stats every 5 minutes
    
    // ✅ MODIFIED: Main loop with retry
    while (true) {

        // ✅ Reset SNA relations setiap cycle baru
        allSNARelations = [];

        const success = await runJobWithRetry();
        
        if (success) {
            log('INFO', 'Cycle completed successfully', {
                totalScraped: stats.totalScraped,
                cycleCount: stats.cycleCount
            });
        } else {
            log('ERROR', 'Cycle failed after retries', {
                cycleCount: stats.cycleCount
            });
        }
        
        const jedaSiklus = CONFIG.JEDA_ANTAR_SIKLUS_MENIT * 60 * 1000;
        console.log(`${"─".repeat(70)}`);
        console.log(`😴 Siklus selesai. Jeda ${CONFIG.JEDA_ANTAR_SIKLUS_MENIT} menit...`);
        console.log(`   Stats: ${stats.totalScraped} total, ${stats.cycleCount} cycles`);
        console.log(`${"─".repeat(70)}\n`);
        
        await new Promise(resolve => setTimeout(resolve, jedaSiklus));
    }
}  // ✅ Closing bracket main() tetap ada

// ✅ MODIFIED: Graceful shutdown with cleanup
process.on('SIGINT', async () => {
    console.log("\n\n⚠️ Shutdown signal received. Cleaning up...");
    
    log('WARN', 'Graceful shutdown initiated');
    // Save current progress before shutdown
    console.log("💾 Saving progress for resume...");
    // Progress already saved by saveProgress() calls
    
    // Save stats
    console.log("📊 Saving statistics...");
    saveStats();

    // ✅ Save final strategy report
    console.log("📊 Saving final strategy report...");
    saveStrategyReport();
    
    // Final backup
    if (CONFIG.BACKUP_ENABLED) {
        console.log("💾 Creating final backup...");
        await createBackup();
    }
    
    log('INFO', 'Shutdown complete');
    console.log("✅ Cleanup complete. Goodbye!\n");
    
    process.exit(0);
});

// ✅ NEW: Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error("\n💥 Uncaught Exception:", error);
    log('ERROR', 'Uncaught exception', {
        error: error.message,
        stack: error.stack
    });
    
    // Save state before crash
    saveCache(true);
    saveStats();
    
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error("\n💥 Unhandled Rejection at:", promise, "reason:", reason);
    log('ERROR', 'Unhandled rejection', {
        reason: String(reason)
    });
});

main().catch(err => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
});