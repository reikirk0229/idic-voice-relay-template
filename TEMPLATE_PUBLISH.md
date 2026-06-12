# IDIC Voice Relay 模板发布说明

这个目录就是给用户部署 Render 中转站用的模板源码。它目前还只是 IDIC 项目里的本地文件夹，用户无法直接使用；需要作者先把它发布成一个单独的 GitHub 仓库。

## 发布成模板仓库

1. 在 GitHub 新建一个公开仓库，例如 `idic-voice-relay-template`。
2. 把 `idic-voice-relay` 目录里的所有文件上传到这个新仓库的根目录。
3. 进入仓库 `Settings`。
4. 勾选 `Template repository`。
5. 把仓库链接放进用户教程里的 Render 中转章节。

## 用户需要看到的链接

最终应该给用户一个类似这样的链接：

```text
https://github.com/你的账号/idic-voice-relay-template
```

用户打开后点击 `Use this template`，再把复制到自己账号里的仓库连接到 Render。

## 注意

这个模板仓库里不应该放腾讯云 SecretId、SecretKey、阿里云 API Key。

用户自己的腾讯云和阿里云密钥仍然填写在 IDIC 网页设置页里。Render 只保存 `IDIC_RELAY_TOKEN` 等中转站自己的环境变量。
