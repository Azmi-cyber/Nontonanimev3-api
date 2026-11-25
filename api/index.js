// Entry point Vercel
// Harus diset SEBELUM @sparticuz/chromium ter-load agar library sistem (libnss3 dll) diekstrak
process.env.AWS_LAMBDA_JS_RUNTIME = process.env.AWS_LAMBDA_JS_RUNTIME || 'nodejs22.x';
module.exports = require('../src/app');
