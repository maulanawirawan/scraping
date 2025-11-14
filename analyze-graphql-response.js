const fs = require('fs');

/**
 * Analyze Facebook GraphQL Search Response Structure
 * Extract all important fields from posts
 */

// Sample response (paste your full response here)
const sampleResponse = require('./sample-response.json');

function analyzeGraphQLStructure(response) {
    console.log('\n=== FACEBOOK GRAPHQL RESPONSE ANALYZER ===\n');

    // Main structure
    const results = response?.data?.serpResponse?.results;
    if (!results) {
        console.error('❌ Invalid response structure');
        return;
    }

    console.log('✅ Valid GraphQL response found!\n');

    // Analyze pagination
    const pageInfo = results.page_info;
    console.log('📄 PAGINATION:');
    console.log(`  - Has next page: ${pageInfo?.has_next_page}`);
    console.log(`  - Cursor length: ${pageInfo?.end_cursor?.length || 0} chars\n`);

    // Analyze filters
    const filters = results.filters;
    console.log('🔍 AVAILABLE FILTERS:');
    filters?.forEach(filterGroup => {
        filterGroup.filters?.forEach(filter => {
            const mainFilter = filter.main_filter;
            console.log(`  - ${mainFilter.name}: ${mainFilter.text}`);
            if (mainFilter.current_value) {
                console.log(`    Current: ${mainFilter.current_value.text}`);
            }
        });
    });
    console.log('');

    // Analyze posts
    const edges = results.edges || [];
    console.log(`📝 TOTAL POSTS: ${edges.length}\n`);

    // Analyze first post in detail
    if (edges.length > 0) {
        const firstPost = extractPostData(edges[0]);
        console.log('📊 SAMPLE POST STRUCTURE:');
        console.log(JSON.stringify(firstPost, null, 2));
    }

    // Extract all posts
    const allPosts = edges.map(edge => extractPostData(edge));

    // Statistics
    console.log('\n📈 STATISTICS:');
    const totalReactions = allPosts.reduce((sum, p) => sum + (p.reactions || 0), 0);
    const totalComments = allPosts.reduce((sum, p) => sum + (p.comments || 0), 0);
    const totalShares = allPosts.reduce((sum, p) => sum + (p.shares || 0), 0);

    console.log(`  Total reactions: ${totalReactions.toLocaleString()}`);
    console.log(`  Total comments: ${totalComments.toLocaleString()}`);
    console.log(`  Total shares: ${totalShares.toLocaleString()}`);
    console.log(`  Avg reactions per post: ${Math.round(totalReactions / allPosts.length)}`);
    console.log(`  Avg comments per post: ${Math.round(totalComments / allPosts.length)}`);

    return allPosts;
}

function extractPostData(edge) {
    try {
        const strategy = edge.rendering_strategy;
        const story = strategy?.view_model?.click_model?.story;

        if (!story) return null;

        // Extract basic info
        const feedback = story.feedback?.comet_ufi_summary_and_actions_renderer?.feedback;

        return {
            // IDs
            story_id: story.id,
            post_id: story.post_id,

            // Author
            author: {
                id: story.actors?.[0]?.id,
                name: story.actors?.[0]?.name,
                url: story.actors?.[0]?.url,
                profile_picture: story.actors?.[0]?.profile_picture?.uri
            },

            // Content
            message: story.message?.text || '',

            // Timestamps
            creation_time: story.comet_sections?.context_layout?.story?.comet_sections?.metadata?.[0]?.story?.creation_time,
            creation_date: story.comet_sections?.context_layout?.story?.comet_sections?.metadata?.[0]?.story?.creation_time
                ? new Date(story.comet_sections.context_layout.story.comet_sections.metadata[0].story.creation_time * 1000).toISOString()
                : null,

            // URL
            url: story.url || story.wwwURL,

            // Attachments
            attachments: (story.attachments || []).map(att => ({
                type: att.media?.__typename,
                id: att.media?.id,
                count: att.styles?.attachment?.all_subattachments?.count || 0,
                items: (att.styles?.attachment?.all_subattachments?.nodes || []).map(node => ({
                    id: node.media?.id,
                    type: node.media?.__typename,
                    image_url: node.media?.image?.uri,
                    viewer_image_url: node.media?.viewer_image?.uri,
                    url: node.url
                }))
            })),

            // Engagement metrics
            reactions: feedback?.reaction_count?.count || 0,
            reactions_breakdown: (feedback?.top_reactions?.edges || []).map(edge => ({
                type: edge.node?.localized_name,
                count: edge.reaction_count
            })),

            comments: feedback?.comment_rendering_instance?.comments?.total_count || 0,
            shares: feedback?.share_count?.count || 0,

            // Privacy
            privacy: story.comet_sections?.context_layout?.story?.privacy_scope?.description,

            // Other metadata
            is_text_only: story.is_text_only_story,
            matched_terms: story.matched_terms || [],

            // Tracking
            encrypted_tracking: story.encrypted_tracking,
            logging_unit_id: edge.logging_unit_id
        };
    } catch (error) {
        console.error('Error extracting post:', error.message);
        return null;
    }
}

function saveExtractedData(posts, filename = 'extracted-posts.json') {
    const data = {
        extracted_at: new Date().toISOString(),
        total_posts: posts.length,
        posts: posts.filter(p => p !== null)
    };

    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    console.log(`\n💾 Saved ${data.posts.length} posts to ${filename}`);

    // Also save as CSV for easy analysis
    const csv = convertToCSV(data.posts);
    const csvFilename = filename.replace('.json', '.csv');
    fs.writeFileSync(csvFilename, csv);
    console.log(`📊 Saved CSV to ${csvFilename}`);
}

function convertToCSV(posts) {
    const headers = [
        'post_id',
        'author_name',
        'author_id',
        'creation_date',
        'message',
        'reactions',
        'comments',
        'shares',
        'url',
        'privacy',
        'attachments_count'
    ];

    const rows = posts.map(post => [
        post.post_id,
        post.author?.name?.replace(/"/g, '""'),
        post.author?.id,
        post.creation_date,
        post.message?.replace(/"/g, '""').replace(/\n/g, ' '),
        post.reactions,
        post.comments,
        post.shares,
        post.url,
        post.privacy,
        post.attachments?.reduce((sum, att) => sum + att.count, 0) || 0
    ]);

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    return csvContent;
}

// Example usage
function main() {
    try {
        // Analyze the response
        const posts = analyzeGraphQLStructure(sampleResponse);

        // Save extracted data
        if (posts && posts.length > 0) {
            saveExtractedData(posts);
        }

        console.log('\n✅ Analysis complete!\n');
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = {
    analyzeGraphQLStructure,
    extractPostData,
    saveExtractedData,
    convertToCSV
};
