import crypto from 'crypto';

console.log('# Copia estos valores a tu .env\n');
console.log(`JWT_ACCESS_SECRET=${crypto.randomBytes(32).toString('hex')}`);
console.log(`JWT_REFRESH_SECRET=${crypto.randomBytes(32).toString('hex')}`);
