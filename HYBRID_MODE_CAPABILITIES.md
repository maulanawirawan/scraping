# 🔄 HYBRID MODE: GraphQL API + HTML Scraping

## ✅ Apa yang Bisa Didapat dari GraphQL API?

Berdasarkan analisis sample response (`sample-response.json`), berikut data yang **BISA** didapat dari Facebook GraphQL API:

### 📊 Data yang TERSEDIA di GraphQL:

| Field | Available? | Path in GraphQL | Kualitas Data |
|-------|-----------|-----------------|---------------|
| **Author Name** | ✅ YES | `story.feedback.owning_profile.name` | **Sangat Akurat** |
| **Author ID** | ✅ YES | `story.feedback.owning_profile.id` | **Sangat Akurat** |
| **Post ID** | ✅ YES | `story.id` | **Sangat Akurat** |
| **Timestamp** | ✅ YES | `story.creation_time` (Unix timestamp) | **Sangat Akurat** - Perlu convert ke ISO |
| **Content Text** | ✅ YES | `story.comet_sections.content.story.comet_sections.message.story.message.text` | **Lengkap** |
| **Post URL** | ✅ YES | `story.attachments[0].styles.attachment.url` | **Sangat Akurat** |
| **Images** | ✅ YES | `story.attachments[0].styles.attachment.all_subattachments.nodes[].media.image.uri` | **Full Resolution** |
| **Image Count** | ✅ YES | `story.attachments[0].styles.attachment.all_subattachments.count` | **Sangat Akurat** |
| **Reactions** | ✅ YES | `story.feedback.reaction_count.count` | **Sangat Akurat** |
| **Comments** | ✅ YES | `story.feedback.comment_count.total_count` | **Sangat Akurat** |
| **Shares** | ✅ YES | `story.feedback.share_count.count` | **Sangat Akurat** |
| **Video URL** | ✅ YES | `story.attachments[].media.playable_url` | **Direct URL** |
| **Views** | ✅ YES | `story.attachments[].media.video_view_count` | **Sangat Akurat** (untuk video) |

### ❌ Data yang TIDAK / JARANG Ada di GraphQL:

| Field | Available? | Catatan |
|-------|-----------|---------|
| **Location** | ❓ PARTIAL | Tidak selalu ada di response. Perlu HTML scraping untuk fallback |
| **Share URL** | ❌ NO | Harus extract dari HTML (click share button) |
| **Translated Content** | ❌ NO | GraphQL tidak handle translation, perlu HTML |

---

## 🎯 Strategi Hybrid Mode

### **Mode 1: GraphQL Priority (Default)**
```
CONFIG.PREFER_GRAPHQL = true
```
1. ✅ Coba ambil data dari GraphQL API dulu
2. ✅ Jika ada field yang kosong/N/A, gunakan HTML scraping untuk melengkapi
3. ✅ Track sumber data untuk setiap field (GraphQL vs HTML)

### **Mode 2: Complement Mode**
```
CONFIG.COMPLEMENT_WITH_HTML = true
```
1. ✅ Ambil data dari kedua sumber (GraphQL + HTML)
2. ✅ Prioritaskan GraphQL untuk: author, timestamp, reactions, comments, shares
3. ✅ Prioritaskan HTML untuk: location, share_url, translated text
4. ✅ Jika ada konflik, pilih data yang lebih lengkap

---

## 📈 Keuntungan Hybrid Mode

### GraphQL API:
- ⚡ **Super Cepat** - Tidak perlu klik/expand/scroll element
- 🎯 **Akurat** - Data langsung dari Facebook internal API
- 📊 **Lengkap** - Engagement metrics sangat akurat
- 🔄 **Structured** - JSON format yang konsisten

### HTML Scraping:
- 📍 **Location** - Bisa extract location dari post
- 🔗 **Share URL** - Bisa dapat actual share URL
- 🌐 **Translation** - Bisa handle translated posts
- 🎨 **Visual Context** - Bisa highlight post yang sedang diproses

---

## 🔍 Cara Kerja Hybrid Mode

### Step 1: Setup Interceptor
```javascript
await setupGraphQLInterceptor(page);
```
- Listen ke semua response dari `/api/graphql/`
- Capture response yang berisi `serpResponse.results`
- Store di variable `latestGraphQLResponse`

### Step 2: Extract HTML Data (Existing)
```javascript
const htmlData = {
    author: authorName,
    timestamp: postTimestamp,
    // ... semua field dari HTML scraping
};
```

### Step 3: Find Matching GraphQL Post
```javascript
const graphqlPost = findGraphQLPostByUrl(latestGraphQLResponse, postUrl);
```
- Cari post di GraphQL response yang match dengan `postUrl`
- Return post data jika ketemu

### Step 4: Merge Data Sources
```javascript
const mergedPost = mergeDataSources(graphqlPost, htmlData);
```
- Merge GraphQL + HTML data
- Prioritas berdasarkan config (`PREFER_GRAPHQL`)
- Track sumber untuk setiap field

### Step 5: Show Data Sources
```javascript
// Console output:
📊 Data Sources: Author:API, Time:API, Text:API, React:API
```

---

## 📝 Contoh Output

### Dengan GraphQL Data:
```
   ✅ Post #1: Found matching post
      -> Author: Prabowo Subianto
      -> Timestamp: 17 December 2024 at 10:30
      -> Text: Sebuah kebanggaan disematkan penghargaan...
      -> R:15000 C:500 S:200
      🔄 GraphQL data found! Merging with HTML data...
      📊 Data Sources: Author:API, Time:API, Text:API, React:API
      💾 Realtime saved to facebook_posts_2024.csv
```

### Tanpa GraphQL Data (HTML Only):
```
   ✅ Post #2: No GraphQL match
      -> Author: Ahmad Dhani
      -> Timestamp: 16 December 2024 at 14:20
      -> Text: Konser malam ini akan spektakuler...
      -> R:2500 C:120 S:45
      ℹ️  No GraphQL match, using HTML data
      📊 Data Sources: Author:HTML, Time:HTML, Text:HTML, React:HTML
      💾 Realtime saved to facebook_posts_2024.csv
```

---

## 🎛️ Config Options

```javascript
// Hybrid Mode Settings
USE_HYBRID_MODE: true,        // Enable GraphQL + HTML hybrid
PREFER_GRAPHQL: true,          // Try GraphQL first
COMPLEMENT_WITH_HTML: true,    // Use HTML to fill missing fields
```

### Kombinasi Config:

| USE_HYBRID | PREFER_GRAPHQL | COMPLEMENT_WITH_HTML | Behavior |
|-----------|---------------|---------------------|----------|
| `true` | `true` | `true` | **BEST**: GraphQL priority, HTML melengkapi |
| `true` | `false` | `true` | HTML priority, GraphQL melengkapi |
| `true` | `true` | `false` | GraphQL only (skip HTML jika ada GraphQL) |
| `false` | - | - | **Traditional**: HTML scraping only |

---

## 📊 Data Quality Comparison

| Field | GraphQL Quality | HTML Quality | Winner |
|-------|----------------|--------------|--------|
| Author | ⭐⭐⭐⭐⭐ (Perfect) | ⭐⭐⭐⭐ (Good, but complex selector) | **GraphQL** |
| Timestamp | ⭐⭐⭐⭐⭐ (Unix, exact) | ⭐⭐⭐ (Relative, need parsing) | **GraphQL** |
| Content | ⭐⭐⭐⭐⭐ (Full text) | ⭐⭐⭐⭐ (May need "See more" expansion) | **GraphQL** |
| Reactions | ⭐⭐⭐⭐⭐ (Exact count) | ⭐⭐⭐ (May show "1K", "10K" etc) | **GraphQL** |
| Comments | ⭐⭐⭐⭐⭐ (Exact count) | ⭐⭐⭐ (May show "1K", "10K" etc) | **GraphQL** |
| Shares | ⭐⭐⭐⭐⭐ (Exact count) | ⭐⭐⭐ (May show "1K", "10K" etc) | **GraphQL** |
| Location | ⭐ (Not available) | ⭐⭐⭐⭐ (Can extract) | **HTML** |
| Share URL | ⭐ (Not available) | ⭐⭐⭐⭐⭐ (Perfect) | **HTML** |
| Images | ⭐⭐⭐⭐⭐ (Full res) | ⭐⭐⭐⭐ (Good, but need srcset parsing) | **GraphQL** |

---

## 🚀 Next Steps

1. ✅ **Test Hybrid Mode** - Run scraper dengan hybrid mode enabled
2. ✅ **Monitor Console** - Lihat output "Data Sources" untuk verify
3. ✅ **Check CSV** - Verify data quality dari hybrid approach
4. ✅ **Adjust Config** - Tune `PREFER_GRAPHQL` dan `COMPLEMENT_WITH_HTML` sesuai kebutuhan

---

## 💡 Tips

1. **GraphQL Response Caching**: Response disimpan di `latestGraphQLResponse`, jadi bisa match dengan multiple posts di feed
2. **URL Matching**: Matching berdasarkan post URL, jadi pastikan URL extraction akurat
3. **Data Sources Tracking**: Internal field `_data_sources` track sumber tiap field (removed sebelum save CSV)
4. **Performance**: GraphQL lebih cepat karena tidak perlu DOM traversal untuk tiap field

---

**Status**: ✅ FULLY IMPLEMENTED & INTEGRATED

**File**: `facebookkey.js` lines 1090-1311 (functions) + 3126-3130 (setup) + 4028-4056 (merge logic)
