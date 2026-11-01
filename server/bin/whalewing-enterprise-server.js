#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { backup, packageInfo, resolveOptions, startServer } from '../src/index.js';

const HELP = `鲸翼企业版服务端 ${packageInfo.version}

用法：
  whalewing-enterprise-server [--data 目录] [--port 端口] [--host 地址] [--trust-proxy]
  whalewing-enterprise-server backup [--data 目录] [--out 备份目录]

  --data          数据目录，默认当前目录下的 data（环境变量 WWE_DATA）
  --port          端口，默认 8730（WWE_PORT）
  --host          监听地址，默认 0.0.0.0；只给本机的反向代理用时写 127.0.0.1（WWE_HOST）
  --trust-proxy   放在 Nginx、Caddy 后面时加上，才能拿到员工的真实地址和 https（WWE_TRUST_PROXY=true）
  --version       显示版本
  --help          显示这段说明

第一次启动会打印初始化码，打开 http://服务器地址:端口/admin/ 按向导填写。
数据都在数据目录里；备份可以用 backup 命令，或停掉服务后复制整个目录。`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, out: { type: 'string' },
      'trust-proxy': { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
} catch (error) {
  console.error(`${error.message}\n\n${HELP}`);
  process.exit(2);
}
const { values, positionals } = parsed;
if (values.help) { console.log(HELP); process.exit(0); }
if (values.version) { console.log(packageInfo.version); process.exit(0); }

const [command = 'start'] = positionals;
try {
  const options = resolveOptions({ data: values.data, port: values.port, host: values.host, trustProxy: values['trust-proxy'] || undefined });
  if (command === 'backup') {
    console.log(`已备份到 ${backup(options.dataDir, values.out)}`);
  } else if (command === 'start') {
    const { app } = await startServer(options);
    const stop = async signal => {
      console.log(`收到 ${signal}，正在停止…`);
      await app.close();
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } else {
    console.error(`不认识的命令：${command}\n\n${HELP}`);
    process.exit(2);
  }
} catch (error) {
  console.error(`启动失败：${error.message}`);
  if (error.code === 'EADDRINUSE') console.error('这个端口已经被别的程序占用了，换一个端口：--port 8731');
  process.exit(1);
}
