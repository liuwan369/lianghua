// PM2 process manager — TypeScript bot
module.exports = {
  apps: [
    {
      name: 'btc-recorder',
      cwd: '/root/projects/btc-5m-market-trading-bot',
      script: 'node',
      args: 'dist/cli/live.js run --log-file results/track/recorder.jsonl',
      autorestart: true,
      max_memory_restart: '600M',
      restart_delay: 15000,
      min_uptime: '30s',
      max_restarts: 50,
      out_file: '/var/log/btc-recorder.pm2.log',
      error_file: '/var/log/btc-recorder.pm2.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'btc-live-a',
      cwd: '/root/projects/btc-5m-market-trading-bot',
      script: './pm2-live-a.sh',
      autorestart: true,
      max_memory_restart: '600M',
      restart_delay: 20000,
      min_uptime: '60s',
      max_restarts: 20,
      out_file: '/var/log/btc-live-a.pm2.log',
      error_file: '/var/log/btc-live-a.pm2.log',
      merge_logs: true,
      time: true,
    },
  ],
};
