# 通用版油猴顺序填空脚本

脚本文件：

`tampermonkey-sequence-autofill.user.js`

## 安装

1. 在 Edge 安装 Tampermonkey。
2. 打开 Tampermonkey 管理面板。
3. 新建脚本。
4. 删除默认内容。
5. 把 `tampermonkey-sequence-autofill.user.js` 里的全部内容粘贴进去。
6. 保存。

## 使用

打开任意网页后，右下角会出现“填空”按钮。

1. 点击“填空”。
2. 粘贴要填写的内容，一行一个。
3. 点击“填入当前页”。
4. 检查页面内容。
5. 需要提交时自己手动提交。

脚本会跳过密码框、隐藏框、已有内容、文件上传、按钮、单选框和复选框。它不会自动提交表单。

右下角按钮会实时显示检测到的可填空格数量，例如 `填空(10)`。面板打开后也会实时刷新空格数量和前 20 个字段标签；页面动态加载、切换题目、输入框出现或消失时不需要重新打开面板。

如果页面存在 `textarea[id^="answerEditor"]` 或 `textarea[name^="answerEditor"]`，脚本会优先只使用这些字段，并按页面 DOM 顺序填入：第一个是第1空，第二个是第2空，依次类推。

如果真正作业在 iframe 里，顶层页面会显示一个可见按钮，地址含 `doHomeWorkNew` 的作业 iframe 会作为 worker 负责检测和填写。顶层和 iframe 之间通过 `postMessage` 通信，不直接跨域读取 iframe DOM。刚打开页面时题目未加载完也没关系，等 `answerEditor` 动态出现后实时检测数量会刷新。

如果面板提示“作业 iframe 没有响应”，通常是 Tampermonkey 没有注入到 iframe。检查 Edge 扩展权限里 Tampermonkey 是否允许访问当前网站，并确认脚本没有 `@noframes`。

## AI 整理

面板里的“AI整理”是可选功能，用来把你粘贴的大段资料整理成“一行一个”的待填列表。支持内置 OpenAI、豆包 / 火山方舟，也支持自定义 OpenAI 兼容接口。

1. 展开“AI整理”。
2. 选择 AI 提供商：`OpenAI`、`豆包 / 火山方舟` 或 `自定义 OpenAI 兼容`。
3. 输入对应 API Key。
4. 模型默认值可以直接用，也可以改成你控制台里的模型名。
   - OpenAI 默认：`gpt-5.4-mini`
   - 豆包默认：`doubao-seed-2-0-lite-260215`
   - 自定义兼容默认：`deepseek-chat`
5. 如果选择 `自定义 OpenAI 兼容`，填写 HTTPS 接口地址，例如 `https://api.example.com/v1/chat/completions`。
6. 把要整理的原始资料粘贴到下面的文本框。
7. 点击“AI整理为列表”。
8. 检查生成的一行一个内容，再点击“填入当前页”。

AI 请求只发送你粘贴的原始资料和检测到的字段标签，不发送网页正文，不会自动提交。

自定义兼容模式走 Chat Completions 格式，适合 DeepSeek、Kimi、通义千问、智谱、硅基流动等提供 OpenAI 兼容接口的平台。接口地址必须是 `https://`，脚本会拒绝明文 `http://`。

## 安全提醒

这是通用脚本，`@match` 是 `http://*/*` 和 `https://*/*`。如果你只想在某个网站使用，可以把脚本顶部改成：

```js
// @match        https://你的域名.com/*
```

并删除通用的 `@match` 行。

为了支持自定义多方 AI，脚本包含 `@connect *`，但它只会在你手动点击“AI整理为列表”时向你填写的接口发起请求。更保守的做法是把 `@connect *` 改成你实际使用的 AI 域名。
