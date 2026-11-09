module.exports = {
  ...require('./jest.config.cjs'),
  testMatch: ['**/test/**/*.integration-spec.ts'],
  testTimeout: 30000,
};
