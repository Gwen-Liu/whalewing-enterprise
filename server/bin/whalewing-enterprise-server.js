#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { backup, packageInfo, purgeTrashOffline, resetPasswordOffline, resolveOptions, startServer } from '../src/index.js';

const HELP = `鲸翼企业版服务端 ${packageInfo.version}

用法：
  whalewing-enterprise-server [--data 目录] [--port 端口] [--host 地址] [--trust-proxy]
  whalewing-enterprise-server backup [--data 目录] [--out 备份目录]
  whalewing-enterprise-server reset-password --username 登录名 [--make-admin] [--data 目录]
  whalewing-enterprise-server purge-trash [--older-than 天数] [--data 目录]

  --data          数据目录，默认当前目录下的 data（环境变量 WWE_DATA）
  --port          端口，默认 8730（WWE_PORT）
  --host          监听地址，默认 0.0.0.0；只给本机的反向代理用时写 127.0.0.1（WWE_HOST）
  --trust-proxy   放在 Nginx、Caddy 后面时加上，才能拿到员工的真实地址和 https（WWE_TRUST_PROXY=true）
  --version       显示版本
  --help          显示这段说明

服务器上的救急命令（系统里没有比管理员更高的账号，这些只能在服务器上做）：
  reset-password  管理员都登不上时用：生成临时密码、作废他已登录的地方、清掉登录锁定；
                  加 --make-admin 顺便把他改成启用的管理员
  purge-trash     彻底删除回收站里的事项（网页里只能放进回收站和恢复）；--older-than 30 只删放进去超过 30 天的

第一次启动会打印初始化码，打开 http://服务器地址:端口/admin/ 按向导填写。
数据都在数据目录里；备份可以用 backup 命令，或停掉服务后复制整个目录。`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, out: { type: 'string' },
      username: { type: 'string' }, 'make-admin': { type: 'boolean' }, 'older-than': { type: 'string' },
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
  } else if (command === 'reset-password') {
    if (!values.username) throw new Error('请用 --username 写要重置的登录名');
    const result = await resetPasswordOffline(options.dataDir, values.username, { makeAdmin: Boolean(values['make-admin']) });
    console.log(`已重置 ${result.username} 的密码。临时密码：${result.password}`);
    console.log(result.admin ? '用它登录管理端后，马上在“设置 → 我的密码”里改掉。' : '他不是管理员，登不了管理端；要救急请加 --make-admin。');
  } else if (command === 'purge-trash') {
    const days = values['older-than'] === undefined ? 0 : Number(values['older-than']);
    if (!Number.isInteger(days) || days < 0) throw new Error('--older-than 要写不小于 0 的整数天数');
    console.log(`已彻底删除回收站里的 ${purgeTrashOffline(options.dataDir, { olderThanDays: days })} 个事项`);
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
