import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const dataDir = process.env.DATA_DIR || path.resolve('data');

export const config = {
  port: Number(process.env.PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  logLevel: process.env.LOG_LEVEL || 'info',

  dataDir,
  dbPath: path.join(dataDir, 'apprunner.sqlite'),
  archiveDir: path.join(dataDir, 'archives'),
  artifactDir: path.join(dataDir, 'artifacts'),
  tmpDir: path.join(dataDir, 'tmp'),

  adminUsername: process.env.ADMIN_USERNAME || 'ege',
  adminPassword: required('ADMIN_PASSWORD'),
  sessionSecret: required('SESSION_SECRET'),
  encryptionKey: required('ENCRYPTION_KEY'),
  cookieSecure: process.env.COOKIE_SECURE !== 'false',

  ci: {
    repo: process.env.CI_REPO || '',
    workflow: process.env.CI_WORKFLOW || 'build-and-test.yml',
    ref: process.env.CI_REF || 'main',
    dispatchToken: process.env.CI_DISPATCH_TOKEN || '',
  },

  firebaseDailyQuota: Number(process.env.FIREBASE_DAILY_QUOTA || 5),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024),

  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
};

export default config;
