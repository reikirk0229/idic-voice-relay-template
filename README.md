# IDIC Voice Relay

Render 上用的 IDIC 语音中转站。它负责把浏览器发来的语音请求转给腾讯云 ASR 和阿里云百炼，避免主站 Netlify Functions 被长音频请求拖到 408/504。

## Render 部署

1. 把这个目录单独上传到 GitHub 仓库，或在 Render 里选择本仓库并把 Root Directory 填成 `idic-voice-relay`。
2. New Web Service，环境选 Node。
3. Build Command: `npm install`
4. Start Command: `npm start`
5. 设置环境变量：

```env
IDIC_RELAY_TOKEN=自己随便填一串长密码
MAX_JSON_MB=12
REQUEST_TIMEOUT_MS=55000
ALIYUN_TIMEOUT_MS=50000
TENCENT_TIMEOUT_MS=20000
```

部署完成后，在 IDIC 设置页填写：

```text
自建语音中转站: 开启
中转站地址: https://你的服务.onrender.com
访问 Token: IDIC_RELAY_TOKEN 的值
```

腾讯云 SecretId/SecretKey 和阿里云百炼 API Key 仍然在 IDIC 设置页填写。Render 只作为用户自己的转发站，不需要用户再去 Render 里配置服务商密钥。

## 接口

- `GET /health`
- `POST /asr/tencent`
- `POST /audio/aliyun-understanding`
- `POST /voice/process`

`/voice/process` 会并行跑腾讯 ASR 和阿里云增强，返回统一结果。IDIC 当前版本先分别调用 `/asr/tencent` 和 `/audio/aliyun-understanding`，保留 `/voice/process` 方便后续一条龙接入。
