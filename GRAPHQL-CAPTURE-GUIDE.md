# 🎯 Facebook GraphQL Response Capture - Complete Guide

Panduan lengkap untuk capture dan analyze Facebook GraphQL API responses

## 📋 Daftar Isi
1. [Struktur Response GraphQL](#struktur-response)
2. [Field-Field Penting](#field-penting)
3. [Auto-Capture Tool](#auto-capture)
4. [Analyze Tool](#analyze)
5. [Tips & Tricks](#tips)

---

## 🔍 Struktur Response GraphQL

### Response Lengkap
```json
{
  "data": {
    "serpResponse": {
      "results": {
        "edges": [...]     // Array of posts
        "filters": [...]   // Available filters
        "page_info": {...} // Pagination info
      }
    }
  }
}
```

### Satu Post (Edge)
```javascript
{
  "node": {...},           // Metadata
  "rendering_strategy": {
    "view_model": {
      "click_model": {
        "story": {
          // SEMUA DATA POST ADA DI SINI!
          "id": "...",
          "post_id": "...",
          "actors": [...],
          "message": {...},
          "attachments": [...],
          "feedback": {...},
          "comet_sections": {...}
        }
      }
    }
  }
}
```

---

## 📊 Field-Field Penting

### 1. Basic Info
```javascript
story.id                 // Story ID (unique)
story.post_id            // Post ID
story.url                // Post URL
```

### 2. Author Info
```javascript
story.actors[0].id               // User ID
story.actors[0].name             // User name
story.actors[0].url              // Profile URL
story.actors[0].profile_picture.uri  // Profile pic URL
```

### 3. Content
```javascript
story.message.text       // Post text/caption
story.is_text_only_story // Boolean
```

### 4. Timestamp
```javascript
story.comet_sections.context_layout.story.comet_sections.metadata[0].story.creation_time
// Unix timestamp (seconds)
```

### 5. Attachments (Photos/Videos)
```javascript
story.attachments[0].styles.attachment.all_subattachments.count  // Total photos
story.attachments[0].styles.attachment.all_subattachments.nodes  // Array of photos

// Each photo:
{
  "media": {
    "id": "...",
    "image": {
      "uri": "...",      // Thumbnail URL
      "height": 393,
      "width": 590
    },
    "viewer_image": {
      "uri": "...",      // Full size URL
      "height": 1365,
      "width": 2048
    }
  },
  "url": "..."           // Direct photo URL
}
```

### 6. Engagement Metrics
```javascript
// Reactions
story.feedback.comet_ufi_summary_and_actions_renderer.feedback.reaction_count.count
// Total reactions

story.feedback.comet_ufi_summary_and_actions_renderer.feedback.top_reactions.edges
// Breakdown by reaction type:
[
  { "node": { "localized_name": "Like" }, "reaction_count": 9231 },
  { "node": { "localized_name": "Love" }, "reaction_count": 582 },
  ...
]

// Comments
story.feedback.comet_ufi_summary_and_actions_renderer.feedback.comment_rendering_instance.comments.total_count

// Shares
story.feedback.comet_ufi_summary_and_actions_renderer.feedback.share_count.count
```

### 7. Privacy
```javascript
story.comet_sections.context_layout.story.privacy_scope.description
// "Public", "Friends", etc.
```

### 8. Pagination
```javascript
data.serpResponse.results.page_info.has_next_page  // Boolean
data.serpResponse.results.page_info.end_cursor     // Cursor for next page
```

### 9. Filters
```javascript
data.serpResponse.results.filters[0].filters
// Available filters (year, author, location, etc.)
```

---

## 🚀 Auto-Capture Tool

### Setup

1. **Install Dependencies**
```bash
npm install puppeteer-extra puppeteer-extra-plugin-stealth
```

2. **Create Config**
```bash
cp config.example.js config.js
# Edit config.js with your credentials
```

3. **Run**
```bash
node auto-capture-graphql.js
```

### What It Does

✅ Auto login ke Facebook
✅ Search query (e.g., "prabowo subianto")
✅ Apply year filter
✅ Scroll otomatis untuk load more posts
✅ Capture SEMUA GraphQL responses
✅ Save ke file JSON
✅ Extract & analyze otomatis
✅ Export ke CSV untuk Excel

### Output Files

```
captured-data/
├── graphql-response-1234567890.json  # Raw response 1
├── graphql-response-1234567891.json  # Raw response 2
├── ...
├── all-posts.json                     # Combined & parsed
└── all-posts.csv                      # Excel-ready CSV
```

---

## 📈 Analyze Tool

### Analyze Existing Response

```bash
node analyze-graphql-response.js
```

### What It Shows

```
=== FACEBOOK GRAPHQL RESPONSE ANALYZER ===

✅ Valid GraphQL response found!

📄 PAGINATION:
  - Has next page: true
  - Cursor length: 2847 chars

🔍 AVAILABLE FILTERS:
  - recent_posts: Recent posts
  - seen_posts: Posts you've seen
  - rp_creation_time: Date posted
    Current: 2023
  - rp_author: Posts from
  - rp_location: Tagged location

📝 TOTAL POSTS: 2

📊 SAMPLE POST STRUCTURE:
{
  "story_id": "...",
  "post_id": "890510642442295",
  "author": {
    "id": "100044501016660",
    "name": "Prabowo Subianto",
    "url": "https://www.facebook.com/PrabowoSubianto",
    "profile_picture": "..."
  },
  "message": "Saya dan atas nama Gibran...",
  "creation_time": 1699513445,
  "creation_date": "2023-11-09T05:30:45.000Z",
  "url": "https://www.facebook.com/...",
  "attachments": [...],
  "reactions": 10000,
  "reactions_breakdown": [
    { "type": "Like", "count": 9231 },
    { "type": "Love", "count": 582 }
  ],
  "comments": 3665,
  "shares": 413,
  "privacy": "Public"
}

📈 STATISTICS:
  Total reactions: 20000
  Total comments: 15765
  Total shares: 1405
  Avg reactions per post: 10000
  Avg comments per post: 7882
```

---

## 💡 Tips & Tricks

### 1. Manual Capture (DevTools)

Jika mau manual capture:

1. Buka Facebook → Search
2. DevTools (F12) → Network tab
3. Filter: `graphql`
4. Look for: `SearchCometResultsPaginatedResultsQuery`
5. Click → Response tab
6. Copy ALL response
7. Save ke file `.json`

### 2. Extract Specific Fields

Edit `analyze-graphql-response.js` function `extractPostData()`:

```javascript
return {
    // Add custom fields here
    custom_field: story.path.to.field,
    ...
};
```

### 3. Pagination

Untuk continue ke next page:

```javascript
const cursor = data.serpResponse.results.page_info.end_cursor;

// Use cursor in next request
// (Usually handled automatically by Facebook when scrolling)
```

### 4. Different Filters

Available filters:
- `rp_creation_time`: Year (2023, 2022, etc.)
- `rp_author`: Author (You, Friends, Public, specific person)
- `rp_location`: Location/place
- `recent_posts`: Recent vs. top posts
- `seen_posts`: Posts you've seen

### 5. Rate Limiting

Facebook might block if too fast:
- Add delays between scrolls
- Use `slowMo` in puppeteer config
- Don't capture too many pages at once
- Use residential proxies if needed

### 6. Headless Mode

For production/server:
```javascript
{
    headless: true,  // No browser UI
    args: [
        '--no-sandbox',
        '--disable-dev-shm-usage'
    ]
}
```

### 7. Error Handling

Common errors:
- **Login failed**: Check credentials, try manual login first
- **Filter not found**: FB UI changed, update selectors
- **No responses captured**: Check GraphQL endpoint URL
- **Timeout**: Increase timeout values in config

---

## 🎯 Common Use Cases

### 1. Scrape All Posts from 2023
```javascript
const capture = new FacebookGraphQLCapture({
    searchQuery: 'prabowo subianto',
    year: '2023',
    maxPages: 10  // Adjust as needed
});
```

### 2. Get Only Photos
Filter in `extractPostData()`:
```javascript
const posts = allPosts.filter(p =>
    p.attachments && p.attachments.length > 0
);
```

### 3. High Engagement Posts Only
```javascript
const viral = allPosts.filter(p =>
    p.reactions > 5000 && p.comments > 1000
);
```

### 4. Export to Excel
CSV file generated automatically!
Open `all-posts.csv` in Excel.

---

## 🔒 Important Notes

⚠️ **Legal & Ethics**
- Only scrape public data
- Respect Facebook's ToS
- Don't spam or abuse
- Use for research/analysis only

⚠️ **Technical**
- Facebook structure changes often
- May need to update selectors
- GraphQL schema can change
- Always test on small dataset first

⚠️ **Rate Limits**
- Don't scrape too fast
- Add random delays
- Use residential proxies
- Rotate accounts if needed

---

## 📞 Troubleshooting

### Issue: No responses captured
**Solution**: Check Network tab manually, verify GraphQL endpoint

### Issue: Login fails
**Solution**:
1. Try manual login first
2. Check if 2FA enabled
3. Use app-specific password

### Issue: Filter doesn't apply
**Solution**:
1. Update XPath selectors
2. Check FB UI changes
3. Add more wait time

### Issue: Incomplete data
**Solution**:
1. Scroll more pages
2. Increase wait times
3. Check if posts are private

---

## 🎓 Advanced

### Modify GraphQL Query

Facebook sends query via POST. To modify:

1. Intercept request in puppeteer
2. Modify request body
3. Continue with modified request

Example:
```javascript
page.on('request', request => {
    if (request.url().includes('SearchCometResultsPaginatedResultsQuery')) {
        // Modify request here
        request.continue({
            postData: modifiedData
        });
    } else {
        request.continue();
    }
});
```

### Direct GraphQL API Call

Instead of browser automation, call API directly:

```javascript
const response = await fetch('https://www.facebook.com/api/graphql/', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': 'YOUR_COOKIES',
        ...
    },
    body: queryString
});
```

**Note**: Need valid cookies & tokens!

---

## ✅ Checklist

Sebelum run:

- [ ] Install dependencies (`npm install`)
- [ ] Copy & edit `config.js`
- [ ] Test login manual dulu
- [ ] Small test run (maxPages: 1)
- [ ] Check output files
- [ ] Full run
- [ ] Analyze results

---

**Happy Scraping! 🚀**

Questions? Issues? Check the code comments or create an issue!
