# 上位机发布说明

## 仓库与部署

- 上位机独立远程仓库：https://github.com/createskyblue/ch58x-th-plot.git
- 发布分支：main。
- GitHub Pages 回源地址：https://createskyblue.github.io/ch58x-th-plot/（发布成功的判断依据）。
- 对外域名 ch58x-th-plot.cacherivulet.cn 由腾讯云 EdgeOne 站点持有，禁止在 GitHub Pages 绑定该域名，禁止提交 CNAME 文件，否则与 EdgeOne 冲突。
- 本目录 web/ 的内容对应独立仓库的根目录，不要把整个固件工程或 web/ 这一层目录推过去。
- 父级固件工程与上位机远程仓库历史独立；不要直接在父级工程执行 git push main，也不要强制推送或合并两段历史。

## 推送授权（硬性规则）

- **每次 `git push` 前都必须拿到用户当次的明确授权**（例如“可以推了”）。不得因为“上一轮已经同意过”而自行推送，也不得把“顺手推一下”当作默认行为。
- 原因：本仓库同时被腾讯云 EdgeOne 回源，**每次推送都会触发一次构建，构建按次收费**。误推等于直接产生费用。
- 未获授权时只允许在本地 commit，然后向用户报告「准备推送哪些提交」，等用户回话。
- 一次改动合并成一次推送，避免为同一件事产生多次构建。

## 推送流程

1. 在本目录检查 git diff，并只提交本次上位机相关文件，避免提交父级目录的无关改动。
2. 在一个新的临时目录克隆独立仓库：

   git clone https://github.com/createskyblue/ch58x-th-plot.git <临时目录>

3. 将本次修改的上位机文件复制到克隆目录的对应根目录路径；新增文件同样复制，明确删除的文件使用 git rm。保留远程仓库其他文件，不要用整目录镜像删除远程内容。
4. 本 AGENTS.md 也发布到独立仓库根目录。若直接在独立仓库工作，则跳过克隆和复制，拉取最新 main 后正常提交。
5. 在克隆目录检查 git status、git diff --stat 和 git diff --check，验证浏览器模块及 HTML 内联脚本语法，针对行为变更执行验证。
6. 使用 git add 显式添加本次文件，git commit 后执行 git push origin main。如果远程有新提交，先拉取并处理差异；只有用户明确要求强制推送时才用 --force。
7. 用 git ls-remote origin refs/heads/main 核对远程提交。推送成功不等于 Pages 已部署；如未验证线上效果，应明确说明。

## 发布注意

- 浏览器模块使用 .js，import 与 script 引用必须同步；本项目曾出现 .mjs 被服务器作为 application/octet-stream 返回、导致模块无法加载的问题。
- 默认壁纸资源为 assets/default-wallpaper.png，确保一同发布。
- 页面固定输出 400×300。原图与黑白预览共用手势逻辑，修改时同时检查手机拖动、双指缩放及页面滚动行为。
- 历史导入逻辑同时存在于 index.html 内联代码与 history-import.js，修改时保持一致。
- 未经用户明确允许，不关闭任何页面、标签页或应用窗口。
