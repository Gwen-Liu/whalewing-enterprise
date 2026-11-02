# 鲸翼企业版服务端

`whalewing-enterprise-server` 是[鲸翼企业版](https://github.com/gwen-liu/whalewing-enterprise)的服务端：账号、部门、权限和团队内容（团队知识、团队专家、团队技能），同时提供员工端接口和管理端网页。每家企业自己部署一份，数据都在自己的服务器上。

## 跑起来

要 Node.js 24 或更新。

```bash
npx whalewing-enterprise-server@0.2.1-rc.5.1 --data ./data
```

国内网络写成 `npx --registry https://registry.npmmirror.com whalewing-enterprise-server@0.2.1-rc.5.1 --data ./data`（`--registry` 要在包名前面）。第一次启动会打印初始化码，打开 `http://服务器地址:8730/admin/` 按向导建企业和第一个管理员。

常用参数：`--port`（默认 8730）、`--host`（默认 0.0.0.0）、`--trust-proxy`（放在 Nginx、Caddy 后面时加上）。`whalewing-enterprise-server backup --data ./data` 备份数据。

外网访问必须配 HTTPS，员工端不连外网的 http 地址。Docker 装法、HTTPS、开机自启、升级和备份见[部署说明](https://github.com/gwen-liu/whalewing-enterprise/blob/main/docs/部署.md)。

## 员工怎么用

员工在 DeepSeek Harness 里装鲸翼个人版 `dsh-whalewing` 和员工端 `dsh-whalewing-enterprise`，在鲸翼的「团队」页签粘贴管理员发的邀请链接加入。

## 许可

AGPL-3.0-only。“鲸翼”“WhaleWing”名称和标志不在许可范围内。
