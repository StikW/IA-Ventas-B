module.exports = {
  apps: [
    {
      name: 'ia-ventas-api',
      cwd: __dirname,
      script: 'dist/main.js',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
