/**
 * StudyPath • Vercel Serverless Function Handler
 * Routes all /api/* requests to the backend request handler.
 */

const handleRequest = require('../server');

module.exports = async (req, res) => {
  return handleRequest(req, res);
};
