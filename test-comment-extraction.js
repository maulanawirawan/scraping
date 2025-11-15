/**
 * ✅ Quick Test Script for Comment Extraction Fix
 *
 * Usage: node test-comment-extraction.js
 *
 * This will:
 * 1. Open browser with saved session
 * 2. Go to a single Facebook post
 * 3. Extract comments using the new HTML method
 * 4. Show results in console
 */

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

// ✅ EDIT THIS: Put a Facebook post URL that has many comments
const TEST_POST_URL = 'https://www.facebook.com/DediMulyadi1971/posts/...'; // ⬅️ CHANGE THIS!

const CONFIG = {
    MAX_COMMENTS_PER_POST: 20, // Test with 20 comments first
    COMMENT_HOVER_RETRY: 2,
    COMMENT_HOVER_DELAY: 2000,
};

/**
 * Clean text for CSV
 */
function cleanTextForCSV(text) {
    if (!text) return "";

    let cleaned = String(text)
        .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
        .trim();

    cleaned = cleaned.replace(/"/g, '""');

    return cleaned;
}

/**
 * ✅ Extract Comments from Dialog (Same as fixed version in facebookkey.js)
 */
async function extractCommentsFromDialog(page, postUrl, postAuthor) {
    const comments = [];

    try {
        console.log(`\n💬 HTML: Extracting from opened dialog...`);

        // STEP 1: Find dialog
        const dialog = page.locator('div[role="dialog"]').first();

        if (await dialog.count() === 0) {
            console.log(`⚠️  No dialog found!`);
            return [];
        }

        // STEP 2: Wait for dialog content to load
        console.log(`⏳ Waiting for comments to load...`);
        await page.waitForTimeout(3000);

        // STEP 3: Wait for loading indicator to disappear
        let loadingCheckAttempts = 0;
        const maxLoadingChecks = 10;

        while (loadingCheckAttempts < maxLoadingChecks) {
            const isLoading = await dialog.locator(
                'div[role="status"][data-visualcompletion="loading-state"][aria-label="Loading..."], ' +
                'div[role="progressbar"]'
            ).count() > 0;

            if (isLoading) {
                console.log(`⏳ Still loading... (${loadingCheckAttempts + 1}/${maxLoadingChecks})`);
                await page.waitForTimeout(2000);
                loadingCheckAttempts++;
            } else {
                console.log(`✅ Loading complete!`);
                break;
            }
        }

        await page.waitForTimeout(1500);

        // STEP 4: Scroll to load ALL comments
        let previousCount = 0;
        let sameCountTimes = 0;
        const maxSameCount = 5;
        let scrollAttempts = 0;
        const maxScrollAttempts = 15;

        while (sameCountTimes < maxSameCount && scrollAttempts < maxScrollAttempts) {
            scrollAttempts++;

            const selectorStrategies = [
                'div[role="article"][aria-label*="Comment by"]',
                'div[role="article"][aria-label*="comment"]',
                'div[role="article"]',
            ];

            let currentCount = 0;
            for (const selector of selectorStrategies) {
                currentCount = await dialog.locator(selector).count();
                if (currentCount > 0) {
                    if (selectorStrategies.indexOf(selector) > 0) {
                        console.log(`ℹ️  Using fallback selector #${selectorStrategies.indexOf(selector) + 1}`);
                    }
                    break;
                }
            }

            if (currentCount >= CONFIG.MAX_COMMENTS_PER_POST) {
                console.log(`ℹ️  Reached max comments limit (${CONFIG.MAX_COMMENTS_PER_POST})`);
                break;
            }

            if (currentCount === previousCount) {
                sameCountTimes++;
                console.log(`-> Same count (${sameCountTimes}/${maxSameCount}): ${currentCount} comments`);
            } else {
                sameCountTimes = 0;
                console.log(`-> Loaded: ${currentCount} comments (+${currentCount - previousCount})`);
            }

            previousCount = currentCount;

            try {
                await dialog.evaluate((el) => {
                    el.scrollTop = el.scrollHeight;
                });
                await page.waitForTimeout(2000);
            } catch (e) {
                console.log(`⚠️  Scroll error: ${e.message.substring(0, 30)}`);
                break;
            }

            const loadingAfterScroll = await dialog.locator(
                'div[role="status"][data-visualcompletion="loading-state"]'
            ).count() > 0;

            if (loadingAfterScroll) {
                console.log(`⏳ Loading more comments...`);
                await page.waitForTimeout(3000);
            }
        }

        // STEP 5: Extract visible comments
        let commentContainers = [];

        const containerSelectors = [
            'div[role="article"][aria-label*="Comment by"]',
            'div[role="article"][aria-label*="comment"]',
            'div[role="article"]',
        ];

        for (const selector of containerSelectors) {
            commentContainers = await dialog.locator(selector).all();

            if (commentContainers.length > 0) {
                console.log(`✅ Found ${commentContainers.length} comments with selector: ${selector.substring(0, 50)}...`);
                break;
            } else {
                console.log(`-> Selector failed: ${selector.substring(0, 50)}...`);
            }
        }

        if (commentContainers.length === 0) {
            console.log(`⚠️  No comment containers found after trying all selectors!`);
            return [];
        }

        const maxComments = Math.min(commentContainers.length, CONFIG.MAX_COMMENTS_PER_POST);

        console.log(`\n📊 Extracting ${maxComments} comments from ${commentContainers.length} total...\n`);

        for (let i = 0; i < maxComments; i++) {
            const commentEl = commentContainers[i];

            try {
                // Visual highlight
                try {
                    await commentEl.evaluate(el => {
                        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    });
                    await page.waitForTimeout(300);

                    await commentEl.evaluate(el => {
                        el.style.border = '3px solid #ff0000';
                        el.style.backgroundColor = '#fff3cd';
                        el.style.transition = 'all 0.3s ease';
                    });

                    await page.waitForTimeout(200);
                } catch (highlightErr) {}

                const comment = {
                    post_url: postUrl,
                    post_author: postAuthor,
                    comment_author: 'Unknown',
                    comment_text: '',
                    comment_timestamp: 'N/A',
                    comment_reactions: 0,
                };

                // Extract author
                const authorSelectors = [
                    'div.xwib8y2.xpdmqnj.x1g0dm76.x1y1aw1k span.xt0psk2 span.xjp7ctv a span.x3nfvp2 span.x193iq5w.xeuugli',
                    'a[role="link"] span.x193iq5w.xeuugli.x13faqbe.x1vvkbs',
                    'a[role="link"] span.x193iq5w.xeuugli',
                    'a[role="link"] span.x193iq5w',
                ];

                for (const selector of authorSelectors) {
                    const authorEl = commentEl.locator(selector).first();
                    if (await authorEl.count() > 0) {
                        const authorText = await authorEl.textContent();
                        if (authorText && authorText.trim()) {
                            comment.comment_author = authorText.trim();
                            break;
                        }
                    }
                }

                // Extract text
                const textSelectors = [
                    'div.x1lliihq.xjkvuk6.x1iorvi4 span[dir="auto"][lang="id-ID"] div.xdj266r div[dir="auto"]',
                    'div.x1lliihq.xjkvuk6.x1iorvi4 span[dir="auto"] div.xdj266r div[dir="auto"]',
                    'div.x1lliihq.xjkvuk6.x1iorvi4 div[dir="auto"][style*="text-align"]',
                    'div.x1lliihq.xjkvuk6.x1iorvi4 div[dir="auto"]',
                ];

                const textParts = [];

                for (const selector of textSelectors) {
                    const textDivs = await commentEl.locator(selector).all();

                    if (textDivs.length > 0) {
                        for (const div of textDivs) {
                            const text = await div.textContent();
                            const cleaned = text ? text.trim() : '';

                            if (cleaned.length > 1 &&
                                !cleaned.match(/^\d+[mhdwy]$/i) &&
                                !cleaned.toLowerCase().includes('like') &&
                                !cleaned.toLowerCase().includes('reply') &&
                                !cleaned.toLowerCase().includes('see translation')) {
                                textParts.push(cleaned);
                            }
                        }

                        if (textParts.length > 0) {
                            break;
                        }
                    }
                }

                const uniqueTexts = [...new Set(textParts)];
                comment.comment_text = cleanTextForCSV(uniqueTexts.join(' '));

                // Extract reactions
                const reactionSelectors = [
                    'div[aria-label*="reaction"][role="button"]',
                    'span[aria-label*="reaction"][role="button"]',
                    'div[aria-label*="reaction"]',
                    'span[aria-label*="reaction"]',
                ];

                for (const selector of reactionSelectors) {
                    const reactionEl = commentEl.locator(selector).first();

                    if (await reactionEl.count() > 0) {
                        const ariaLabel = await reactionEl.getAttribute('aria-label');

                        if (ariaLabel) {
                            const match = ariaLabel.match(/(\d+)\s+reactions?/i);
                            if (match) {
                                comment.comment_reactions = parseInt(match[1], 10);
                                break;
                            }
                        }
                    }
                }

                if (comment.comment_text) {
                    comments.push(comment);

                    // Cleanup highlight
                    try {
                        await commentEl.evaluate(el => {
                            el.style.border = '';
                            el.style.backgroundColor = '';
                        });
                    } catch (cleanupErr) {}

                    // Log progress
                    console.log(`✅ [${comments.length}] ${comment.comment_author}: "${comment.comment_text.substring(0, 50)}..." (${comment.comment_reactions} reactions)`);
                } else {
                    console.log(`⚠️  Comment ${i + 1}: No text, skipped`);
                }

            } catch (err) {
                console.warn(`⚠️ Error extracting comment ${i + 1}: ${err.message.substring(0, 60)}`);
            }
        }

        console.log(`\n✅ Extracted ${comments.length} comments from dialog`);

        return comments;

    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        return [];
    }
}

/**
 * Main test function
 */
async function runTest() {
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║   🧪 COMMENT EXTRACTION TEST                         ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');

    if (TEST_POST_URL.includes('...')) {
        console.error('❌ ERROR: Please edit TEST_POST_URL in this file first!');
        console.error('   Line 14: const TEST_POST_URL = "https://www.facebook.com/..."');
        process.exit(1);
    }

    const userDataDir = path.join(os.homedir(), 'playwright_fb_session');

    let context;
    try {
        console.log('🚀 Launching browser...');
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            channel: 'chrome',
            viewport: { width: 1920, height: 1080 },
        });

        const page = await context.newPage();

        console.log(`\n🌐 Opening post: ${TEST_POST_URL}\n`);
        await page.goto(TEST_POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

        await page.waitForTimeout(3000);

        // Check login
        try {
            await page.waitForSelector('a[aria-label="Home"]', { timeout: 5000 });
            console.log('✅ Logged in\n');
        } catch (e) {
            console.error('❌ Not logged in! Please login to Facebook first.');
            await context.close();
            process.exit(1);
        }

        // Click comment button
        console.log('🔘 Clicking comment button...');
        const commentBtn = page.locator('span.xkrqix3.x1sur9pj:has-text("comment")').first();

        if (await commentBtn.count() === 0) {
            console.error('❌ Comment button not found!');
            await context.close();
            process.exit(1);
        }

        const parentButton = page.locator('div[role="button"]:has(span:has-text("comment"))').first();
        await parentButton.click({ timeout: 5000 });

        await page.waitForTimeout(3000);

        // Verify dialog opened
        const dialog = page.locator('div[role="dialog"]').first();
        if (await dialog.count() === 0) {
            console.error('❌ Comment dialog did not open!');
            await context.close();
            process.exit(1);
        }

        console.log('✅ Comment dialog opened\n');

        // Extract comments
        const comments = await extractCommentsFromDialog(page, TEST_POST_URL, 'Test Author');

        // Show results
        console.log('\n╔═══════════════════════════════════════════════════════╗');
        console.log('║   📊 TEST RESULTS                                    ║');
        console.log('╚═══════════════════════════════════════════════════════╝\n');

        console.log(`✅ Total comments extracted: ${comments.length}`);

        if (comments.length > 0) {
            console.log('\n📝 Sample comments:\n');
            comments.slice(0, 5).forEach((comment, i) => {
                console.log(`${i + 1}. Author: ${comment.comment_author}`);
                console.log(`   Text: "${comment.comment_text.substring(0, 100)}..."`);
                console.log(`   Reactions: ${comment.comment_reactions}`);
                console.log('');
            });

            console.log('✅ TEST PASSED! Comment extraction is working!\n');
        } else {
            console.log('⚠️  TEST FAILED: No comments extracted.');
            console.log('   Check console output above for errors.\n');
        }

        // Close dialog
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);

        console.log('Press Ctrl+C to exit (or wait 10 seconds)...');
        await page.waitForTimeout(10000);

    } catch (error) {
        console.error('\n❌ TEST ERROR:', error.message);
        console.error(error.stack);
    } finally {
        if (context) {
            await context.close();
        }
        console.log('\n✅ Browser closed. Test complete!\n');
    }
}

// Run test
runTest().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
