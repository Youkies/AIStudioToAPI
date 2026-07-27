<!--
 * File: ui/app/pages/AccountsPage.vue
 * Description: Credential store and login queue — import accounts, watch the
 *              queue work through them, and inspect what a failure looked like.
-->

<template>
    <div v-cloak class="accounts-page">
        <el-card shadow="never" class="section">
            <template #header>
                <div class="section-header">
                    <span>账号管理</span>
                    <div class="header-actions">
                        <el-tag v-if="queue.breakerTripped" type="danger" effect="dark">熔断已触发</el-tag>
                        <el-tag v-else-if="queue.paused" type="warning">队列已暂停</el-tag>
                        <el-tag v-else type="success">队列运行中</el-tag>
                        <el-button size="small" @click="refresh">刷新</el-button>
                    </div>
                </div>
            </template>

            <el-alert v-if="queue.breakerTripped" type="error" show-icon :closable="false" class="mb">
                连续 {{ queue.consecutiveFailures }} 个账号登录失败，队列已自动停止。 先看失败详情再决定是否继续 ——
                每次失败的尝试都会被 Google 记录。
            </el-alert>

            <!-- import -->
            <el-collapse v-model="openPanels">
                <el-collapse-item name="import" title="粘贴导入">
                    <div class="hint">
                        每行一个账号，字段用
                        <code>----</code> 分隔（也支持 <code>|</code> / Tab）：<br />
                        <code>邮箱----密码----辅助邮箱----2FA密钥----代理host:port:user:pass</code><br />
                        字段顺序自适应，多余字段（如 OAuth token）会被忽略；代理可留空、之后再改。
                    </div>
                    <el-input
                        v-model="importText"
                        type="textarea"
                        :rows="6"
                        placeholder="user@gmail.com----password----recovery@x.com----BASE32SECRET----dc.decodo.com:10001:user:pass"
                    />
                    <div class="row-end">
                        <el-button type="primary" :loading="importing" @click="doImport">导入</el-button>
                    </div>
                </el-collapse-item>
            </el-collapse>

            <!-- queue controls -->
            <div class="queue-bar">
                <el-button v-if="queue.paused" type="primary" size="small" @click="control('start')">
                    启动队列
                </el-button>
                <el-button v-else size="small" @click="control('pause')">暂停</el-button>
                <el-button size="small" :disabled="!queue.pending.length" @click="control('clear')">
                    清空待办 ({{ queue.pending.length }})
                </el-button>
                <el-divider direction="vertical" />
                <span class="label">并发</span>
                <el-input-number v-model="settings.concurrency" :min="1" :max="5" size="small" @change="saveSettings" />
                <span class="label">超时(分)</span>
                <el-input-number v-model="timeoutMinutes" :min="1" :max="30" size="small" @change="saveSettings" />
                <span class="label">熔断阈值</span>
                <el-input-number
                    v-model="settings.breakerThreshold"
                    :min="1"
                    :max="20"
                    size="small"
                    @change="saveSettings"
                />
                <el-divider direction="vertical" />
                <el-button type="primary" size="small" :disabled="!selected.length" @click="enqueueSelected">
                    登录选中 ({{ selected.length }})
                </el-button>
            </div>

            <!-- active -->
            <div v-if="queue.active.length" class="active-strip">
                <el-tag v-for="a in queue.active" :key="a.email" type="primary" effect="plain">
                    {{ a.email }} · {{ a.stage }} · {{ Math.round(a.elapsedMs / 1000) }}s
                </el-tag>
            </div>

            <!-- accounts -->
            <el-table
                :data="accounts"
                size="small"
                height="440"
                @selection-change="rows => (selected = rows.map(r => r.email))"
            >
                <el-table-column type="selection" width="42" />
                <el-table-column prop="email" label="账号" min-width="210" show-overflow-tooltip />
                <el-table-column label="状态" width="110">
                    <template #default="{ row }">
                        <el-tag v-if="row.last_status === 'success'" type="success" size="small">已登录</el-tag>
                        <el-tag v-else-if="row.last_status === 'failed'" type="danger" size="small">
                            失败 {{ row.consecutive_failures }}
                        </el-tag>
                        <el-tag v-else type="info" size="small">未登录</el-tag>
                    </template>
                </el-table-column>
                <el-table-column label="凭据" width="96">
                    <template #default="{ row }">
                        <el-tag v-if="row.has_password" size="small" effect="plain">密码</el-tag>
                        <el-tag v-if="row.has_totp" size="small" effect="plain" type="warning">2FA</el-tag>
                    </template>
                </el-table-column>
                <el-table-column prop="proxy" label="代理" min-width="160" show-overflow-tooltip>
                    <template #default="{ row }">
                        <span v-if="row.proxy">{{ row.proxy }}</span>
                        <el-tag v-else size="small" type="danger" effect="plain">无</el-tag>
                    </template>
                </el-table-column>
                <el-table-column label="auth" width="70">
                    <template #default="{ row }">
                        <span v-if="row.auth_index !== undefined">#{{ row.auth_index }}</span>
                        <span v-else class="muted">—</span>
                    </template>
                </el-table-column>
                <el-table-column label="最近" min-width="150">
                    <template #default="{ row }">
                        <span v-if="row.last_attempt_at" class="muted">
                            {{ fmtTime(row.last_attempt_at) }} · {{ row.last_stage }}
                        </span>
                    </template>
                </el-table-column>
                <el-table-column label="操作" width="176" align="right">
                    <template #default="{ row }">
                        <el-button link size="small" @click="enqueueOne(row.email)">登录</el-button>
                        <el-button v-if="row.last_attempt_id" link size="small" @click="showDiagnostics(row)">
                            诊断
                        </el-button>
                        <el-button link size="small" @click="editRow(row)">编辑</el-button>
                        <el-button link size="small" type="danger" @click="removeRow(row)">删除</el-button>
                    </template>
                </el-table-column>
            </el-table>

            <!-- history -->
            <el-collapse v-model="openPanels" class="mt">
                <el-collapse-item name="history" :title="`最近尝试 (${queue.history.length})`">
                    <el-table :data="queue.history" size="small" height="240">
                        <el-table-column label="" width="60">
                            <template #default="{ row }">
                                <el-tag :type="row.ok ? 'success' : 'danger'" size="small">
                                    {{ row.ok ? "OK" : "失败" }}
                                </el-tag>
                            </template>
                        </el-table-column>
                        <el-table-column prop="email" label="账号" min-width="200" show-overflow-tooltip />
                        <el-table-column prop="stage" label="阶段" width="150" />
                        <el-table-column label="耗时" width="80">
                            <template #default="{ row }">{{ (row.durationMs / 1000).toFixed(0) }}s</template>
                        </el-table-column>
                        <el-table-column prop="error" label="错误" min-width="220" show-overflow-tooltip />
                        <el-table-column label="" width="70" align="right">
                            <template #default="{ row }">
                                <el-button v-if="!row.ok" link size="small" @click="openAttempt(row.attemptId)">
                                    详情
                                </el-button>
                            </template>
                        </el-table-column>
                    </el-table>
                </el-collapse-item>
            </el-collapse>
        </el-card>

        <!-- edit dialog -->
        <el-dialog v-model="editVisible" title="编辑账号" width="480">
            <el-form v-if="editing" label-width="92">
                <el-form-item label="账号">
                    <el-input :model-value="editing.email" disabled />
                </el-form-item>
                <el-form-item label="密码">
                    <el-input v-model="editForm.password" placeholder="留空则不修改" show-password />
                </el-form-item>
                <el-form-item label="2FA 密钥">
                    <el-input v-model="editForm.totp_secret" placeholder="留空则不修改" />
                </el-form-item>
                <el-form-item label="代理主机">
                    <el-input v-model="editForm.proxy_host" placeholder="dc.decodo.com" />
                </el-form-item>
                <el-form-item label="代理端口">
                    <el-input v-model="editForm.proxy_port" placeholder="10001" />
                </el-form-item>
                <el-form-item label="代理用户">
                    <el-input v-model="editForm.proxy_username" />
                </el-form-item>
                <el-form-item label="代理密码">
                    <el-input v-model="editForm.proxy_password" show-password />
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button @click="editVisible = false">取消</el-button>
                <el-button type="primary" @click="saveEdit">保存</el-button>
            </template>
        </el-dialog>

        <!-- diagnostics dialog -->
        <el-dialog v-model="diagVisible" title="失败诊断" width="760">
            <div v-if="diag">
                <el-descriptions :column="1" size="small" border>
                    <el-descriptions-item label="阶段">{{ diag.reason }} / {{ diag.stage }}</el-descriptions-item>
                    <el-descriptions-item label="URL">
                        <span class="mono">{{ diag.url }}</span>
                    </el-descriptions-item>
                    <el-descriptions-item label="标题">{{ diag.title }}</el-descriptions-item>
                    <el-descriptions-item label="页面文本">
                        <div class="body-text">{{ diag.body }}</div>
                    </el-descriptions-item>
                    <el-descriptions-item label="选择器命中">
                        <div v-for="(v, k) in diag.selectors" :key="k" class="mono small">
                            {{ k }} → count={{ v.count }} visible={{ v.visible }}
                        </div>
                    </el-descriptions-item>
                </el-descriptions>
                <img v-if="diagShot" :src="diagShot" class="shot" alt="screenshot" />
            </div>
            <el-empty v-else description="没有诊断数据" />
        </el-dialog>
    </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";

const accounts = ref([]);
const selected = ref([]);
const importText = ref("");
const importing = ref(false);
const openPanels = ref(["import"]);

const queue = reactive({
    active: [],
    breakerTripped: false,
    consecutiveFailures: 0,
    history: [],
    paused: true,
    pending: [],
});
const settings = reactive({ breakerThreshold: 3, concurrency: 1, perAccountTimeoutMs: 300000 });
const timeoutMinutes = computed({
    get: () => Math.round(settings.perAccountTimeoutMs / 60000),
    set: v => (settings.perAccountTimeoutMs = v * 60000),
});

const editVisible = ref(false);
const editing = ref(null);
const editForm = reactive({});
const diagVisible = ref(false);
const diag = ref(null);
const diagShot = ref("");

let timer = null;

async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        ...options,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
}

async function loadAccounts() {
    accounts.value = (await api("/api/login/accounts")).accounts;
}

async function loadQueue() {
    const s = await api("/api/login/queue");
    Object.assign(queue, s);
    Object.assign(settings, s.settings);
}

async function refresh() {
    await Promise.all([loadAccounts(), loadQueue()]);
}

async function doImport() {
    if (!importText.value.trim()) return;
    importing.value = true;
    try {
        const r = await api("/api/login/accounts/import", { body: { text: importText.value }, method: "POST" });
        ElMessage.success(
            `导入完成：新增 ${r.created}，更新 ${r.updated}${r.skipped.length ? `，跳过 ${r.skipped.length}` : ""}`
        );
        importText.value = "";
        await loadAccounts();
    } catch (e) {
        ElMessage.error(e.message);
    } finally {
        importing.value = false;
    }
}

async function control(action, email) {
    await api("/api/login/queue/control", { body: { action, email }, method: "POST" });
    await loadQueue();
}

async function saveSettings() {
    await api("/api/login/queue/settings", { body: { ...settings }, method: "PUT" });
    await loadQueue();
}

async function enqueue(emails) {
    const r = await api("/api/login/queue/enqueue", { body: { emails, reason: "manual" }, method: "POST" });
    ElMessage.success(`已加入队列 ${r.added.length} 个`);
    await loadQueue();
}
const enqueueOne = email => enqueue([email]);
const enqueueSelected = () => enqueue(selected.value);

function editRow(row) {
    editing.value = row;
    Object.assign(editForm, {
        password: "",
        proxy_host: "",
        proxy_password: "",
        proxy_port: "",
        proxy_username: "",
        totp_secret: "",
    });
    const [host, port] = (row.proxy || "").split(":");
    editForm.proxy_host = host || "";
    editForm.proxy_port = port || "";
    editVisible.value = true;
}

async function saveEdit() {
    // Blank password/2FA means "leave as is" — sending "" would erase them.
    const patch = {};
    for (const [k, v] of Object.entries(editForm)) {
        if (v !== "" && v !== undefined) patch[k] = k === "proxy_port" ? Number(v) : v;
    }
    await api(`/api/login/accounts/${encodeURIComponent(editing.value.email)}`, { body: patch, method: "PUT" });
    editVisible.value = false;
    await loadAccounts();
    ElMessage.success("已保存");
}

async function removeRow(row) {
    await ElMessageBox.confirm(`删除账号 ${row.email}？凭据会被移除，已推送的 auth 文件不受影响。`, "确认", {
        type: "warning",
    });
    await api(`/api/login/accounts/${encodeURIComponent(row.email)}`, { method: "DELETE" });
    await loadAccounts();
}

async function openAttempt(attemptId) {
    diag.value = await api(`/api/login/attempts/${attemptId}`).catch(() => null);
    diagShot.value = diag.value ? `/api/login/attempts/${attemptId}/screenshot` : "";
    diagVisible.value = true;
}
const showDiagnostics = row => openAttempt(row.last_attempt_id);

const fmtTime = ts => (ts ? new Date(ts).toLocaleString() : "");

onMounted(() => {
    refresh();
    // Poll rather than stream: the queue moves on a scale of tens of seconds,
    // so a socket would buy nothing over a 3s tick.
    timer = setInterval(loadQueue, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.accounts-page {
    margin: 0 auto;
    max-width: 1200px;
    padding: 16px;
}
.section-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
}
.header-actions {
    align-items: center;
    display: flex;
    gap: 8px;
}
.hint {
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.8;
    margin-bottom: 8px;
}
.row-end {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
}
.queue-bar {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0;
}
.queue-bar .label {
    color: var(--el-text-color-secondary);
    font-size: 12px;
}
.active-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
}
.muted {
    color: var(--el-text-color-secondary);
    font-size: 12px;
}
.mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    word-break: break-all;
}
.small {
    font-size: 11px;
}
.body-text {
    max-height: 130px;
    overflow: auto;
    white-space: pre-wrap;
}
.shot {
    border: 1px solid var(--el-border-color);
    margin-top: 12px;
    width: 100%;
}
.mb {
    margin-bottom: 12px;
}
.mt {
    margin-top: 12px;
}
</style>
