/**
 * ✅ FACEBOOK GRAPHQL API - JSON Structure Explorer
 *
 * Purpose: Explore JSON structure without seeing full values
 * Usage: node graphql-explorer.js
 */

const fs = require('fs');

/**
 * ✅ EXPLORE JSON STRUCTURE - Keys only, no long values
 * @param {Object} obj - JSON object to explore
 * @param {Number} depth - Current depth level
 * @param {Number} maxDepth - Maximum depth to explore
 * @param {String} indent - Indentation string
 */
function exploreStructure(obj, depth = 0, maxDepth = 5, indent = '') {
    if (depth > maxDepth) {
        console.log(`${indent}... (max depth reached)`);
        return;
    }

    if (obj === null) {
        console.log(`${indent}null`);
        return;
    }

    if (obj === undefined) {
        console.log(`${indent}undefined`);
        return;
    }

    const type = typeof obj;

    // Primitive types
    if (type === 'string') {
        const preview = obj.length > 50 ? `"${obj.substring(0, 47)}..."` : `"${obj}"`;
        console.log(`${indent}${preview} (string, length: ${obj.length})`);
        return;
    }

    if (type === 'number' || type === 'boolean') {
        console.log(`${indent}${obj} (${type})`);
        return;
    }

    // Array
    if (Array.isArray(obj)) {
        console.log(`${indent}[ Array, length: ${obj.length} ]`);
        if (obj.length > 0) {
            console.log(`${indent}  [0]:`);
            exploreStructure(obj[0], depth + 1, maxDepth, indent + '    ');

            if (obj.length > 1) {
                console.log(`${indent}  ... (${obj.length - 1} more items)`);
            }
        }
        return;
    }

    // Object
    if (type === 'object') {
        const keys = Object.keys(obj);
        console.log(`${indent}{ Object, keys: ${keys.length} }`);

        for (const key of keys) {
            console.log(`${indent}  "${key}":`);
            exploreStructure(obj[key], depth + 1, maxDepth, indent + '    ');
        }
        return;
    }

    console.log(`${indent}${obj} (${type})`);
}

/**
 * ✅ EXTRACT KEY PATHS - Get all possible key paths in JSON
 * @param {Object} obj - JSON object
 * @param {String} currentPath - Current path
 * @param {Array} paths - Accumulated paths
 */
function extractKeyPaths(obj, currentPath = '', paths = []) {
    if (obj === null || obj === undefined) {
        return paths;
    }

    const type = typeof obj;

    if (type === 'string' || type === 'number' || type === 'boolean') {
        paths.push({ path: currentPath, type: type, sample: obj });
        return paths;
    }

    if (Array.isArray(obj)) {
        paths.push({ path: currentPath, type: 'array', length: obj.length });
        if (obj.length > 0) {
            extractKeyPaths(obj[0], `${currentPath}[0]`, paths);
        }
        return paths;
    }

    if (type === 'object') {
        const keys = Object.keys(obj);
        paths.push({ path: currentPath, type: 'object', keys: keys.length });

        for (const key of keys) {
            const newPath = currentPath ? `${currentPath}.${key}` : key;
            extractKeyPaths(obj[key], newPath, paths);
        }
        return paths;
    }

    return paths;
}

/**
 * ✅ PRETTY PRINT KEY PATHS
 */
function printKeyPaths(paths) {
    console.log('\n📋 ALL KEY PATHS:\n');
    console.log('Path'.padEnd(80) + ' | Type'.padEnd(12) + ' | Info');
    console.log('='.repeat(120));

    for (const item of paths) {
        const pathStr = item.path.padEnd(80);
        const typeStr = item.type.padEnd(12);

        let info = '';
        if (item.type === 'array') {
            info = `length: ${item.length}`;
        } else if (item.type === 'object') {
            info = `keys: ${item.keys}`;
        } else if (item.type === 'string') {
            const preview = typeof item.sample === 'string' && item.sample.length > 30
                ? `"${item.sample.substring(0, 27)}..."`
                : `"${item.sample}"`;
            info = preview;
        } else {
            info = String(item.sample);
        }

        console.log(`${pathStr} | ${typeStr} | ${info}`);
    }
}

/**
 * ✅ SAVE STRUCTURE TO FILE
 */
function saveStructure(obj, filename = 'json_structure.txt') {
    const originalLog = console.log;
    let output = '';

    console.log = (...args) => {
        output += args.join(' ') + '\n';
    };

    exploreStructure(obj);

    console.log = originalLog;

    fs.writeFileSync(filename, output, 'utf8');
    console.log(`\n✅ Structure saved to: ${filename}`);
}

/**
 * ✅ MAIN - Test with sample data
 */
if (require.main === module) {
    console.log('╔═══════════════════════════════════════════════════════════════════╗');
    console.log('║        🔍 FACEBOOK GRAPHQL JSON STRUCTURE EXPLORER               ║');
    console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

    // Test with sample Facebook GraphQL response
    const sampleResponse = {
        "data": {
            "serpResponse": {
                "results": {
                    "edges": [
                        {
                            "node": {
                                "role": "TOP_PUBLIC_POSTS",
                                "__typename": "SearchRenderable"
                            },
                            "rendering_strategy": {
                                "__typename": "SearchRichPostRenderingStrategy",
                                "view_model": {
                                    "__typename": "SearchPostViewModel",
                                    "click_model": {
                                        "story": {
                                            "id": "UzpfSTEwMDA0NDUwMTAxNjY2MDo3NDY4ODIwNTAxMzg0ODk6NzQ2ODgyMDUwMTM4NDg5",
                                            "feedback": {
                                                "id": "ZmVlZGJhY2s6NzQ2ODgyMDUwMTM4NDg5",
                                                "owning_profile": {
                                                    "__typename": "User",
                                                    "name": "Prabowo Subianto",
                                                    "id": "100044501016660"
                                                }
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
                                                                                "uri": "https://scontent.fcgk33-1.fna.fbcdn.net/...",
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
                                                                        "text": "Sebuah kebanggaan disematkan..."
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

    console.log('📊 EXPLORING STRUCTURE (Keys Only):\n');
    exploreStructure(sampleResponse, 0, 10);

    console.log('\n' + '='.repeat(120) + '\n');

    const paths = extractKeyPaths(sampleResponse);
    printKeyPaths(paths);

    console.log('\n💾 Saving structure to file...');
    saveStructure(sampleResponse, 'facebook_graphql_structure.txt');

    console.log('\n✅ Done! Now you can see the structure without long values.');
    console.log('💡 TIP: Use this to understand GraphQL response format.\n');
}

module.exports = {
    exploreStructure,
    extractKeyPaths,
    printKeyPaths,
    saveStructure
};
