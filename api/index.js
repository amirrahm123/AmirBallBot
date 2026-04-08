// Vercel serverless entry point
const app = require('../dist/server');
module.exports = app.default || app;
