module.exports = {
  apps: [
    {
      name: 'dualloop',
      script: './src/orchestrator.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        DUALLOOP_DAEMON: '1'
      }
    }
  ]
};
