import dynalite from 'dynalite';
import dotenv from 'dotenv';

dotenv.config();

const PORT = Number(process.env.DYNAMODB_PORT ?? 8000);

const server = dynalite({ createTableMs: 0 });

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n⚠️  El puerto ${PORT} ya está en uso.`);
    console.log('DynamoDB Local (dynalite) probablemente ya está corriendo.');
    console.log('\n→ Puedes continuar directamente con: npm run dev');
    console.log('→ Para reiniciarlo: cierra la terminal donde corre dynalite, o ejecuta:');
    console.log(`   npx kill-port ${PORT}   (luego npm run dynamodb:start)\n`);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`DynamoDB Local (dynalite) running at http://localhost:${PORT}`);
  console.log('Keep this terminal open while developing.');
  console.log('In another terminal run: npm run db:init && npm run seed && npm run dev');
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
