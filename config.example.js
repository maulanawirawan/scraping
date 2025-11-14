/**
 * Facebook GraphQL Capture Configuration
 * Copy this file to config.js and fill in your details
 */

module.exports = {
    // Facebook credentials
    facebook: {
        email: 'YOUR_EMAIL@gmail.com',
        password: 'YOUR_PASSWORD'
    },

    // Search parameters
    search: {
        query: 'prabowo subianto',
        year: '2023', // Filter by year
        maxPages: 5   // Number of pages to scroll
    },

    // Output settings
    output: {
        dir: './captured-data',
        saveRaw: true,        // Save raw GraphQL responses
        saveParsed: true,     // Save parsed/extracted data
        saveCSV: true         // Save as CSV for Excel
    },

    // Browser settings
    browser: {
        headless: false,      // Set to true for headless mode
        slowMo: 0,           // Slow down by ms for debugging
        devtools: false      // Open devtools automatically
    },

    // Advanced options
    advanced: {
        waitAfterLogin: 3000,    // ms to wait after login
        waitAfterSearch: 3000,   // ms to wait after search
        waitAfterFilter: 5000,   // ms to wait after applying filter
        scrollDelay: 5000        // ms to wait between scrolls
    }
};
