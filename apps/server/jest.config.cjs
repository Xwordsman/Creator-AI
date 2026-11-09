module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.spec.ts'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
};
