# Docmost 权限架构

本文档总结当前 Docmost 对页面、空间、工作区、用户组以及文件下载的权限管理机制。

## 总览

Docmost 的权限是分层生效的：

```text
JWT workspace validation
  -> workspace role
  -> space membership
  -> page restriction, if present
  -> attachment lookup and page visibility check
```

可以按下面的规则理解：

- Workspace 权限控制租户级别的管理能力。
- Group 是 workspace 范围内的用户集合。
- Space 是主要的内容区和协作边界。
- Page 权限可以在 space 权限之上继续收窄访问范围。
- 文件下载会通过附件所属页面的可见权限进行授权。

## 角色模型

角色枚举定义在 `apps/server/src/common/helpers/types/permission.ts`。

### Workspace 角色

```text
owner
admin
member
```

`owner` 和 `admin` 可以管理 workspace 设置、成员、spaces、groups、附件和
API keys。`owner` 还有一些 owner-only 权限，例如删除 workspace 或审计相关能力。

`member` 可以读取 workspace 级别的元数据，例如设置、成员、spaces 和 groups。
除非被 workspace 设置限制，member 可以创建 API key。这里的附件能力不会绕过
page 级别的下载或上传检查。

### Space 角色

```text
admin
writer
reader
```

`admin` 可以管理 space 设置、成员、页面、分享以及删除 space。

`writer` 可以读取 space 设置和成员，并可以管理页面与分享。实际效果是，writer
可以创建、编辑、移动和分享页面，除非被 page 级别限制覆盖。

`reader` 可以读取 space 设置、成员、页面和分享状态，但不能编辑页面。

### Page Permission 角色

```text
writer
reader
```

Page permission 只在当前页面或其某个祖先页面存在 `page_access` 限制时生效。

`writer` 可以查看和编辑受限页面子树，并可以管理页面权限。

`reader` 可以查看受限页面子树，但不能编辑。

## 数据模型

核心关系如下：

```text
workspaces
  ├─ users.workspace_id
  ├─ groups.workspace_id
  │    └─ group_users: group <-> user
  └─ spaces.workspace_id
       └─ space_members
            ├─ user_id  + role
            └─ group_id + role
```

`space_members` 接受 `user_id` 或 `group_id`，但不能同时存在。这由数据库 check
constraint 保证。它还分别对 `space_id + user_id` 和 `space_id + group_id` 有唯一
约束。

页面同时属于一个 workspace 和一个 space：

```text
pages.workspace_id
pages.space_id
pages.parent_page_id
```

页面限制使用两张表：

```text
page_access
  - page_id unique
  - workspace_id
  - space_id
  - access_level = restricted

page_permissions
  - page_access_id
  - user_id or group_id
  - role = reader/writer
```

附件同样有归属范围：

```text
attachments.workspace_id
attachments.space_id
attachments.page_id
attachments.file_path
```

对于页面附件，`workspace_id`、`space_id` 和 `page_id` 必须全部正确，下载授权才会通过。

## 实体关系与权限传播

Docmost 的内容权限不是单一 ACL，而是由 workspace、group、space、page 四类实体共同组成。

```text
workspace
  ├─ 决定租户边界和全局管理能力
  ├─ 拥有 users
  ├─ 拥有 groups
  └─ 拥有 spaces

group
  ├─ 只在所属 workspace 内有效
  ├─ 通过 group_users 绑定用户
  └─ 被加入 space_members 或 page_permissions 后才产生内容权限

space
  ├─ 属于一个 workspace
  ├─ 拥有 pages
  ├─ 通过 space_members 授权 user/group
  └─ 是默认的页面读写边界

page
  ├─ 属于一个 workspace 和一个 space
  ├─ 通过 parent_page_id 形成树
  ├─ 默认继承 space 的读写能力
  └─ 可通过 page_access/page_permissions 进一步收窄访问范围
```

### Workspace 与内容权限

Workspace role 主要控制全局管理功能，例如 workspace 设置、成员管理、group 管理、
space 创建、API key 管理、审计等。它不直接等价于“能看所有页面”。

实际查看页面时，服务端仍会进入 space 和 page 检查。也就是说，workspace `member`
必须通过 `space_members` 才能读取某个 space 内的页面。workspace `admin`/`owner`
虽然能管理很多全局资源，但具体页面读取、编辑、附件下载仍会经过对应的 space/page
授权路径。

### Group 的作用

Group 是授权主体，不是权限本身。一个 group 只有在被挂到下面任一位置后，才产生实际内容权限：

```text
space_members.group_id
page_permissions.group_id
```

典型用途：

- 给一个 group 授予某个 space 的 `reader`、`writer` 或 `admin`。
- 给一个 group 授予某个受限 page 的 `reader` 或 `writer`。
- 通过调整 `group_users` 批量改变一组用户的有效权限。

因此排查 group 权限时，要同时检查：

```text
groups.workspace_id
group_users.user_id/group_id
space_members.group_id
page_permissions.group_id
```

### Space 是默认内容边界

没有 page restriction 时，space role 决定 page 权限：

```text
space admin  -> 可读、可写、可管理 space 设置和成员
space writer -> 可读、可写页面，可管理页面与分享
space reader -> 只能读取页面
```

用户可以通过两种方式获得 space role：

```text
直接授权: space_members.user_id = user.id
组授权:   group_users.user_id = user.id
          + space_members.group_id = group_users.group_id
```

如果同一个用户有多个 space role，取最高角色：

```text
admin > writer > reader
```

### Page Restriction 是收窄层

Page restriction 不会扩大 space 权限，只会在已有 space 可读基础上进一步收窄页面树的访问。

有效规则可以写成：

```text
能否查看 page =
  用户是该 space 成员
  AND space role 至少可读
  AND 如果 page 或祖先 page 有 restriction:
        用户/用户所属 group 必须在每一个受限祖先上都有 page permission

能否编辑 page =
  能查看 page
  AND 如果没有 restriction:
        space role 是 writer 或 admin
      如果有 restriction:
        最近的受限祖先上，用户/用户所属 group 必须是 writer
```

这里有两个重要含义：

- 父页面被限制后，所有子孙页面都会受到影响。
- 子页面可以再加自己的 restriction，但不会取消父页面 restriction；用户仍需通过整条受限祖先链。

## Workspace 初始化

创建 workspace 时，Docmost 也会创建：

- 默认 group，通常是 `Everyone`。
- 默认 space，`General`。
- 创建者成为 workspace `owner`。
- 创建者成为 `General` space 的 `admin`。
- 默认 group 以 `writer` 身份加入 `General` space。
- `workspace.default_space_id` 指向 `General`。

新用户注册时会加入 workspace 和默认 group。因此普通用户的默认访问路径通常是：

```text
user -> Everyone group -> General space writer
```

## Space 访问

Space membership 可以是直接授权，也可以来自 group。

当用户在同一个 space 中拥有多个角色时，例如直接角色是 `reader`，group 角色是
`writer`，Docmost 会选择最高角色：

```text
admin > writer > reader
```

`spaces` 表有 `visibility` 和 `default_role` 字段，默认值分别是 `private` 和
`writer`。但是当前 space 列表和权限执行主要使用实际的 `space_members` 记录。
因此判断有效 space 权限时，应把 `space_members` 视为事实来源。

## Page 访问

Page 访问由 `PageAccessService` 执行。

### 查看

查看页面需要满足：

1. 用户必须是页面所属 space 的成员。
2. 用户必须有 space 级别的页面读取权限。
3. 如果该页面或任一祖先页面被限制，用户必须在每一个受限祖先上都有匹配的
   user 或 group permission。

### 编辑

编辑页面需要满足：

1. 用户必须先通过查看检查。
2. 如果没有 page restriction，space 级别的 writer/admin 能力就足够。
3. 如果当前页面或任一祖先页面被限制，则由 page-level permission 接管。
4. 最近的受限祖先决定是否可以编辑。
5. 用户需要在这个最近的受限祖先上拥有 `writer`。

这意味着父页面上的限制会影响所有子孙页面。子页面可以再增加一个直接限制，但用户仍然
需要在权限链上的每一个受限祖先上都有权限。

## Page Restriction 管理

限制一个页面时，系统会创建一条 `page_access` 记录，并把操作者作为 `writer`
加入，避免页面创建限制后没有管理者。

移除权限或把 writer 降级时，系统会检查受限页面至少保留一个 writer，避免意外锁死。

Space admin 可以管理 page restriction，作为恢复路径。

Restriction 发生变化时，系统会对受影响的子树重新入队索引。受限页面会被排除在不应暴露
私有内容的检索或搜索索引路径之外。

## 文件上传

普通文件上传使用：

```text
POST /files/upload
```

请求必须包含 `pageId`。

服务端流程：

1. 加载页面。
2. 调用 `PageAccessService.validateCanEdit(page, user)`。
3. 将文件写入 storage。
4. 插入一条包含 `workspace_id`、`space_id` 和 `page_id` 的 `attachments` 记录。

用户只有在可以编辑所属页面时，才能上传普通页面附件。

## 文件下载

登录后的文件下载使用：

```text
GET /files/:fileId/:fileName
```

服务端流程：

1. 校验 `fileId` 是否为 UUID。
2. 加载附件。
3. 验证 `attachment.workspace_id` 是否匹配当前 workspace。
4. 对普通页面附件，要求存在 `page_id` 和 `space_id`。
5. 加载附件所属页面。
6. 调用 `PageAccessService.validateCanView(page, user)`。
7. 授权通过后流式返回文件。

AI chat 附件是特殊情况。它们只能由上传该附件的用户读取。

## 限制附件下载的设置与方法

当前 Docmost 的普通页面附件没有独立的“附件 ACL”。附件下载权限跟随附件所属页面：

```text
能查看附件所属 page -> 能通过 /files/:fileId/:fileName 读取附件
不能查看附件所属 page -> 不能读取附件
```

因此限制附件下载的核心做法，是限制附件所属 page 或其上层 space/page tree 的可见性。

### 方法一：限制 Space Membership

如果某些用户不应该下载某个 space 内的任何附件，可以从 space 层处理：

- 将用户从 `space_members` 移除。
- 将用户所在 group 从 `space_members` 移除。
- 将 group/user 的 space role 降为不具备所需能力的角色。

对下载来说，只要用户不再能查看附件所属 page，就不能下载该 page 的附件。

适用场景：

- 整个 space 是一个权限边界。
- 某些 group 不应访问该 space 的所有内容。
- 需要批量控制大量页面和附件。

### 方法二：使用 Page Restriction

如果只想限制某个页面或某个页面子树中的附件下载，应对页面加 restriction。

做法：

- 对含有附件的 page 创建 `page_access` restriction。
- 在 `page_permissions` 中只加入允许访问的 user/group。
- 需要可编辑和可管理权限的人授予 `writer`。
- 只允许查看和下载的人授予 `reader`。

因为附件下载会调用 `PageAccessService.validateCanView(page, user)`，所以没有 page
查看权限的人无法下载该页面附件。

适用场景：

- 同一个 space 中只有部分页面需要保密。
- 某个父页面及其所有子页面需要形成一个受限专区。
- 需要基于 group 精细控制附件可见范围。

### 方法三：限制父页面

如果一个目录型父页面下面有很多子页面和附件，可以限制父页面，而不是逐个限制附件或子页面。

```text
restricted parent page
  ├─ child page A
  │    └─ attachment A
  └─ child page B
       └─ attachment B
```

用户必须通过父页面 restriction，才能访问子页面和子页面附件。这适合把某个知识树整体变成受限区域。

### 方法四：关闭或避免 Public Share

公开分享页面会为附件生成 public attachment token：

```text
GET /files/public/:fileId/:fileName?jwt=...
```

如果不希望外部用户下载附件：

- 不要公开分享含敏感附件的页面。
- 删除已有 share。
- 在 space 安全设置中禁用 public sharing。
- 避免把受限页面公开分享；受限页面本身也应被阻止公开分享。

Public attachment token 虽然会绑定 `attachmentId`、`pageId`、`workspaceId`，但只要 token
有效，持有者就可以读取对应公开附件。因此敏感内容应从源头避免进入 public share。

### 方法五：确保 Storage 不被直接暴露

Docmost 的权限检查发生在 API 层。如果部署时把 storage 目录、S3 bucket 或对象存储路径
直接公开，就会绕过 `/files/:fileId/:fileName` 的授权逻辑。

部署时应确保：

- 本地 storage 目录不能被 Nginx/Apache 静态目录直接暴露。
- S3 或兼容对象存储 bucket 不应设为 public read。
- 读取附件必须经过 Docmost API。
- CDN 如有使用，也应只缓存经过授权的响应，不能直接指向原始 storage。

这是附件下载限制中最容易被忽略、也最危险的一层。

### 方法六：使用 AI Chat 附件的 Creator-only 模型

AI chat 附件是特殊类型，不走 page 可见性模型。它们只能由上传者读取：

```text
attachment.ai_chat_id 存在
AND attachment.creator_id == current_user.id
```

这适合聊天上下文中的私有上传文件，但不适用于普通 page attachment。

### 目前不支持的精细策略

如果需求是：

```text
用户可以查看 page，但不能下载该 page 的附件
```

当前原生模型不直接支持。因为附件、图片、PDF、音频、视频等都通过同一套文件接口读取；
只要页面能展示这些资源，浏览器实际上已经获取了文件内容。

若要实现“可看页面但禁止下载附件”，需要新增后端权限策略，例如：

```text
space/page 增加 allowAttachmentDownload 设置
attachment 增加 download_policy
AttachmentController.getFile 增加下载权限检查
前端隐藏下载按钮
后端强制拒绝非 inline 或所有附件下载
```

需要注意：前端隐藏按钮只能改善体验，不能作为安全边界。真正的限制必须在
`AttachmentController.getFile` 和 public attachment 下载路径中强制执行。

## 公开附件下载

公开分享页面中的附件使用：

```text
GET /files/public/:fileId/:fileName?jwt=...
```

该 token 是一个附件 JWT，作用域绑定到：

```text
attachmentId
pageId
workspaceId
```

服务端要求：

- URL 中的 `fileId` 等于 token 中的 `attachmentId`。
- Token 中的 `workspaceId` 等于当前 workspace。
- 附件存在于同一个 workspace。
- 附件拥有 `page_id` 和 `space_id`。
- 附件的 `page_id` 等于 token 中的 `pageId`。

这可以防止公开附件 token 被复用到其他页面或其他 workspace。

## 迁移检查清单

迁移数据到 Docmost 时，尤其是从 MrDoc 迁移时，需要验证这些不变量：

- `users.workspace_id` 正确。
- `groups.workspace_id` 正确。
- `group_users` 包含预期的成员关系。
- `spaces.workspace_id` 正确。
- `space_members` 为用户或 group 授予了预期的 space 角色。
- `pages.workspace_id`、`pages.space_id` 和 `pages.parent_page_id` 正确。
- `page_access` 和 `page_permissions` 与预期的受限页面树一致。
- `attachments.workspace_id`、`attachments.space_id` 和 `attachments.page_id` 正确。
- `attachments.file_path` 指向 Docmost storage 中真实存在的对象。

最常见的附件失败模式是：只有 metadata，但缺少正确的 `page_id` 或 `space_id`；
或者有 metadata，但 storage 中没有实际文件。这两种情况都会导致下载路径失败。

## 快速排查模型

调试时可以按这个顺序检查：

```text
Can the user authenticate into this workspace?
  If no: JWT/workspace/session issue.

Is the user a member of the target space, directly or through a group?
  If no: space_members/group_users issue.

Can the user read or write according to the highest space role?
  If no: space role issue.

Does the page or any ancestor have page_access?
  If yes: every restricted ancestor needs page_permissions for this user/group.

Is this an attachment?
  If yes: attachment must point to the correct workspace, space, page, and
  storage path, then the owning page's view permission must pass.
```
