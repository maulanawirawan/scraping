const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { analyzeGraphQLStructure, extractPostData, saveExtractedData } = require('./analyze-graphql-response');

puppeteer.use(StealthPlugin());

/**
 * AUTO-CAPTURE FACEBOOK GRAPHQL RESPONSES
 * Automatically login, search, filter, and capture responses
 */

class FacebookGraphQLCapture {
    constructor(config) {
        this.config = {
            email: config.email,
            password: config.password,
            searchQuery: config.searchQuery || 'prabowo subianto',
            year: config.year || '2023',
            maxPages: config.maxPages || 5,
            outputDir: config.outputDir || './captured-data',
            headless: config.headless !== false
        };

        this.browser = null;
        this.page = null;
        this.capturedResponses = [];
    }

    async init() {
        console.log('🚀 Initializing Facebook GraphQL Capture...\n');

        // Create output directory
        if (!fs.existsSync(this.config.outputDir)) {
            fs.mkdirSync(this.config.outputDir, { recursive: true });
        }

        // Launch browser
        this.browser = await puppeteer.launch({
            headless: this.config.headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080'
            ]
        });

        this.page = await this.browser.newPage();

        // Set viewport
        await this.page.setViewport({ width: 1920, height: 1080 });

        // Set user agent
        await this.page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Setup request interception to capture GraphQL responses
        await this.setupRequestInterception();

        console.log('✅ Browser initialized\n');
    }

    async setupRequestInterception() {
        await this.page.setRequestInterception(true);

        this.page.on('request', request => {
            request.continue();
        });

        this.page.on('response', async response => {
            const url = response.url();

            // Capture GraphQL search responses
            if (url.includes('graphql') && url.includes('SearchCometResultsPaginatedResultsQuery')) {
                try {
                    const data = await response.json();

                    if (data?.data?.serpResponse?.results) {
                        console.log(`📦 Captured GraphQL response (${response.status()})`);

                        const timestamp = new Date().toISOString();
                        const responseData = {
                            timestamp,
                            url,
                            status: response.status(),
                            headers: response.headers(),
                            data
                        };

                        this.capturedResponses.push(responseData);

                        // Save immediately
                        const filename = `graphql-response-${Date.now()}.json`;
                        const filepath = path.join(this.config.outputDir, filename);
                        fs.writeFileSync(filepath, JSON.stringify(responseData, null, 2));

                        console.log(`  💾 Saved to: ${filename}\n`);
                    }
                } catch (error) {
                    // Not JSON or failed to parse
                }
            }
        });
    }

    async login() {
        console.log('🔐 Logging in to Facebook...\n');

        await this.page.goto('https://www.facebook.com/', {
            waitUntil: 'networkidle2'
        });

        // Wait for login form
        await this.page.waitForSelector('input[name="email"]', { timeout: 10000 });

        // Enter credentials
        await this.page.type('input[name="email"]', this.config.email, { delay: 100 });
        await this.page.type('input[name="pass"]', this.config.password, { delay: 100 });

        // Click login
        await this.page.click('button[name="login"]');

        // Wait for navigation
        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

        console.log('✅ Login successful\n');

        // Wait a bit for Facebook to fully load
        await this.delay(3000);
    }

    async search() {
        console.log(`🔍 Searching for: "${this.config.searchQuery}"\n`);

        // Go to search
        const searchUrl = `https://www.facebook.com/search/posts?q=${encodeURIComponent(this.config.searchQuery)}`;
        await this.page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        await this.delay(3000);

        console.log('✅ Search page loaded\n');
    }

    async applyYearFilter() {
        console.log(`📅 Applying year filter: ${this.config.year}\n`);

        try {
            // Wait for filters to load
            await this.delay(2000);

            // Look for "Date posted" filter button
            const filterButton = await this.page.$x("//span[contains(text(), 'Date posted')]");

            if (filterButton.length > 0) {
                await filterButton[0].click();
                await this.delay(1000);

                // Click on the year
                const yearButton = await this.page.$x(`//span[contains(text(), '${this.config.year}')]`);
                if (yearButton.length > 0) {
                    await yearButton[0].click();
                    await this.delay(3000);

                    console.log(`✅ Filter applied: Year ${this.config.year}\n`);
                } else {
                    console.log(`⚠️  Year ${this.config.year} button not found\n`);
                }
            } else {
                console.log('⚠️  Date posted filter not found\n');
            }
        } catch (error) {
            console.error('❌ Error applying filter:', error.message);
        }

        // Wait for results to load with filter
        await this.delay(5000);
    }

    async scrollAndCapture() {
        console.log(`📜 Scrolling to capture up to ${this.config.maxPages} pages...\n`);

        for (let i = 0; i < this.config.maxPages; i++) {
            console.log(`  Page ${i + 1}/${this.config.maxPages}...`);

            // Scroll to bottom
            await this.page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });

            // Wait for new content to load
            await this.delay(5000);

            // Check if we've hit the end
            const noMorePosts = await this.page.evaluate(() => {
                return document.body.textContent.includes('No more posts');
            });

            if (noMorePosts) {
                console.log('\n  ℹ️  Reached end of results\n');
                break;
            }
        }

        console.log('✅ Scrolling complete\n');
    }

    async processAllResponses() {
        console.log('📊 Processing all captured responses...\n');

        const allPosts = [];

        for (const response of this.capturedResponses) {
            try {
                const posts = this.extractPostsFromResponse(response.data);
                allPosts.push(...posts);
            } catch (error) {
                console.error('Error processing response:', error.message);
            }
        }

        console.log(`✅ Extracted ${allPosts.length} posts total\n`);

        // Save combined data
        const combinedFile = path.join(this.config.outputDir, 'all-posts.json');
        saveExtractedData(allPosts, combinedFile);

        return allPosts;
    }

    extractPostsFromResponse(data) {
        const edges = data?.data?.serpResponse?.results?.edges || [];
        return edges.map(edge => extractPostData(edge)).filter(p => p !== null);
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }

    async run() {
        try {
            await this.init();
            await this.login();
            await this.search();
            await this.applyYearFilter();
            await this.scrollAndCapture();

            const posts = await this.processAllResponses();

            console.log('\n✅ CAPTURE COMPLETE!\n');
            console.log(`📁 Data saved to: ${this.config.outputDir}`);
            console.log(`📊 Total posts extracted: ${posts.length}\n`);

            return posts;
        } catch (error) {
            console.error('\n❌ ERROR:', error.message);
            console.error(error.stack);
            throw error;
        } finally {
            await this.close();
        }
    }
}

// Example usage
async function main() {
    const capture = new FacebookGraphQLCapture({
        email: 'YOUR_EMAIL@gmail.com',
        password: 'YOUR_PASSWORD',
        searchQuery: 'prabowo subianto',
        year: '2023',
        maxPages: 5,
        outputDir: './captured-data',
        headless: false // Set to true for headless mode
    });

    await capture.run();
}

// Run if called directly
if (require.main === module) {
    main().catch(console.error);
}

module.exports = FacebookGraphQLCapture;
