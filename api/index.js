/**
 * StudyPath • Vercel Serverless Function Entry Point
 * Routes all /api/* requests to the unified Node.js request handler.
 */

const handleRequest = require('../server');

module.exports = async (req, res) => {
  return handleRequest(req, res);
};
