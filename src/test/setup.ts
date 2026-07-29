import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-minimum-32-chars-long';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-minimum-32-chars-long';
process.env.OPENAI_API_KEY ??= 'sk-test-key-for-unit-tests';
