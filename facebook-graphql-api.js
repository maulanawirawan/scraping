/**
 * ✅ FACEBOOK GRAPHQL API - Helper & Data Extractor
 *
 * Purpose: Call Facebook GraphQL API and extract post data
 * Usage: Use functions to make GraphQL requests
 */

const { exploreStructure, extractKeyPaths } = require('./graphql-explorer');

/**
 * ✅ EXTRACT POST DATA from GraphQL Response
 * @param {Object} response - GraphQL API response
 * @returns {Array} - Array of extracted posts
 */
function extractPostsFromResponse(response) {
    const posts = [];

    try {
        const edges = response?.data?.serpResponse?.results?.edges || [];

        console.log(`📊 Found ${edges.length} edges in response`);

        for (let i = 0; i < edges.length; i++) {
            const edge = edges[i];

            try {
                // Navigate the deep structure
                const story = edge?.rendering_strategy?.view_model?.click_model?.story;

                if (!story) {
                    console.log(`   ⏭️  Edge ${i + 1}: No story found`);
                    continue;
                }

                // Extract basic info
                const postId = story.id || 'N/A';
                const feedbackId = story.feedback?.id || 'N/A';

                // Extract author
                const author = story.feedback?.owning_profile?.name || 'N/A';
                const authorId = story.feedback?.owning_profile?.id || 'N/A';

                // Extract message/text
                const messageObj = story.comet_sections?.content?.story?.comet_sections?.message?.story?.message;
                const text = messageObj?.text || '';

                // Extract post URL from attachments
                let postUrl = 'N/A';
                const attachments = story.attachments || [];
                if (attachments.length > 0) {
                    postUrl = attachments[0]?.styles?.attachment?.url || 'N/A';
                }

                // Extract images
                const images = [];
                if (attachments.length > 0) {
                    const subattachments = attachments[0]?.styles?.attachment?.all_subattachments?.nodes || [];

                    for (const sub of subattachments) {
                        const imageUri = sub?.media?.image?.uri;
                        if (imageUri) {
                            images.push(imageUri);
                        }
                    }
                }

                // Extract timestamp (if available in full response)
                const timestamp = story.creation_time || story.publish_time || 'N/A';

                // Extract engagement (if available)
                const reactions = story.feedback?.reaction_count?.count || 0;
                const comments = story.feedback?.comment_count?.total_count || 0;
                const shares = story.feedback?.share_count?.count || 0;

                const post = {
                    post_id: postId,
                    feedback_id: feedbackId,
                    author: author,
                    author_id: authorId,
                    text: text,
                    post_url: postUrl,
                    images: images,
                    image_count: images.length,
                    timestamp: timestamp,
                    reactions: reactions,
                    comments: comments,
                    shares: shares,
                    extracted_at: new Date().toISOString()
                };

                posts.push(post);
                console.log(`   ✅ Post ${i + 1}: ${author} - ${text.substring(0, 50)}...`);

            } catch (err) {
                console.error(`   ❌ Error extracting edge ${i + 1}: ${err.message}`);
            }
        }

    } catch (err) {
        console.error(`❌ Error extracting posts from response: ${err.message}`);
    }

    return posts;
}

/**
 * ✅ BUILD GRAPHQL QUERY - For Facebook Search
 * @param {String} query - Search query
 * @param {Object} filters - Search filters
 * @returns {String} - GraphQL query string
 */
function buildSearchQuery(query, filters = {}) {
    // This is a placeholder - actual query needs to be captured from browser
    return {
        query: query,
        filters: filters,
        // Add more parameters as needed
    };
}

/**
 * ✅ MAKE GRAPHQL REQUEST - Using Playwright page context
 * @param {Page} page - Playwright page
 * @param {Object} variables - GraphQL variables
 * @returns {Object} - GraphQL response
 */
async function makeGraphQLRequest(page, variables) {
    try {
        // Intercept GraphQL requests
        const response = await page.evaluate(async (vars) => {
            const response = await fetch('https://www.facebook.com/api/graphql/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-FB-Friendly-Name': 'SearchCometResultsPaginatedResultsQuery'
                },
                body: new URLSearchParams(vars)
            });

            return await response.json();
        }, variables);

        return response;

    } catch (err) {
        console.error(`❌ GraphQL request error: ${err.message}`);
        return null;
    }
}

/**
 * ✅ CAPTURE GRAPHQL REQUEST - From browser network tab
 * @param {Page} page - Playwright page
 * @param {Function} triggerAction - Function that triggers the GraphQL request
 * @returns {Object} - Captured request data
 */
async function captureGraphQLRequest(page, triggerAction) {
    const capturedRequests = [];

    // Listen to all requests
    page.on('request', (request) => {
        if (request.url().includes('/api/graphql/')) {
            const headers = request.headers();
            const postData = request.postData();

            capturedRequests.push({
                url: request.url(),
                method: request.method(),
                headers: headers,
                postData: postData,
                timestamp: new Date().toISOString()
            });

            console.log(`📡 Captured GraphQL request: ${headers['x-fb-friendly-name'] || 'unknown'}`);
        }
    });

    // Trigger the action that causes GraphQL request
    await triggerAction();

    // Wait a bit for request to complete
    await page.waitForTimeout(2000);

    return capturedRequests;
}

/**
 * ✅ INTERCEPT & EXTRACT - Capture response directly
 * @param {Page} page - Playwright page
 * @param {Function} triggerAction - Function that triggers the request
 * @returns {Object} - Response data
 */
async function interceptAndExtract(page, triggerAction) {
    let graphqlResponse = null;

    // Listen to responses
    page.on('response', async (response) => {
        if (response.url().includes('/api/graphql/')) {
            try {
                const json = await response.json();
                graphqlResponse = json;

                console.log(`📥 Intercepted GraphQL response`);

                // Show structure
                console.log('\n📊 Response Structure:');
                exploreStructure(json, 0, 3);

            } catch (err) {
                console.error(`⚠️  Could not parse response: ${err.message}`);
            }
        }
    });

    // Trigger the action
    await triggerAction();

    // Wait for response
    await page.waitForTimeout(3000);

    return graphqlResponse;
}

/**
 * ✅ SAVE REQUEST TEMPLATE - For reuse
 */
function saveRequestTemplate(requestData, filename = 'graphql_template.json') {
    const fs = require('fs');

    const template = {
        url: requestData.url,
        method: requestData.method,
        headers: requestData.headers,
        postData: requestData.postData,
        saved_at: new Date().toISOString()
    };

    fs.writeFileSync(filename, JSON.stringify(template, null, 2));
    console.log(`✅ Template saved to: ${filename}`);
}

/**
 * ✅ TEST - Extract from sample response
 */
if (require.main === module) {
    console.log('╔═══════════════════════════════════════════════════════════════════╗');
    console.log('║        📡 FACEBOOK GRAPHQL API - Data Extractor                  ║');
    console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

    // Sample response (truncated)
    const sampleResponse = {
        "data": {
            "serpResponse": {
                "results": {
                    "edges": [
                        {
                            "rendering_strategy": {
                                "view_model": {
                                    "click_model": {
                                        "story": {
                                            "id": "UzpfSTEwMDA0NDUwMTAxNjY2MDo3NDY4ODIwNTAxMzg0ODk",
                                            "feedback": {
                                                "id": "ZmVlZGJhY2s6NzQ2ODgyMDUwMTM4NDg5",
                                                "owning_profile": {
                                                    "__typename": "User",
                                                    "name": "Prabowo Subianto",
                                                    "id": "100044501016660"
                                                },
                                                "reaction_count": { "count": 15000 },
                                                "comment_count": { "total_count": 500 },
                                                "share_count": { "count": 200 }
                                            },
                                            "attachments": [
                                                {
                                                    "styles": {
                                                        "attachment": {
                                                            "url": "https://www.facebook.com/PrabowoSubianto/posts/pfbid0SC2JKc5VRWZcWcoFdJ7vNNPvA6TNN7kzg1U29fq8EJ9ckVoAGspgAjrv7WGUMnf2l",
                                                            "all_subattachments": {
                                                                "count": 9,
                                                                "nodes": [
                                                                    {
                                                                        "media": {
                                                                            "__typename": "Photo",
                                                                            "image": {
                                                                                "uri": "https://scontent.fcgk33-1.fna.fbcdn.net/v/t39.30808-6/472675344_1149536199873070_6052449745431068037_n.jpg",
                                                                                "height": 565,
                                                                                "width": 584
                                                                            }
                                                                        }
                                                                    }
                                                                ]
                                                            }
                                                        }
                                                    }
                                                }
                                            ],
                                            "comet_sections": {
                                                "content": {
                                                    "story": {
                                                        "comet_sections": {
                                                            "message": {
                                                                "story": {
                                                                    "message": {
                                                                        "text": "Sebuah kebanggaan disematkan penghargaan sebagai warga kehormatan Korps Marinir..."
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        }
    };

    console.log('🔍 Extracting posts from sample response...\n');
    const posts = extractPostsFromResponse(sampleResponse);

    console.log('\n📊 EXTRACTED POSTS:\n');
    console.log(JSON.stringify(posts, null, 2));

    console.log(`\n✅ Successfully extracted ${posts.length} post(s)!`);
    console.log('\n💡 TIP: Use captureGraphQLRequest() with Playwright to capture real requests.\n');
}

module.exports = {
    extractPostsFromResponse,
    buildSearchQuery,
    makeGraphQLRequest,
    captureGraphQLRequest,
    interceptAndExtract,
    saveRequestTemplate
};
