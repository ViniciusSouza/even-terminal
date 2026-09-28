export function truncate(v, max = 200) {
    if (typeof v !== "string" || !v)
        return null;
    return v.length > max ? v.slice(0, max) : v;
}
/** First meaningful input field, for the permission_request detail line. */
export function detailFromInput(input) {
    return (truncate(input.command) ??
        truncate(input.file_path) ??
        truncate(input.url) ??
        truncate(input.prompt) ??
        truncate(input.query) ??
        truncate(input.content, 100) ??
        "");
}
export function mapTodoWrite(input) {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    if (todos.length === 0)
        return [];
    const total = todos.length;
    const completed = todos.filter((t) => t?.status === "completed").length;
    const active = todos.find((t) => t?.status === "in_progress");
    const current = active
        ? String(active.content ?? active.activeForm ?? "")
        : completed === total
            ? "All done"
            : "";
    return [{ type: "task_progress", completed, total, current }];
}
export function normalizeQuestions(input) {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    return questions.map((q) => ({
        question: String(q?.question ?? ""),
        header: String(q?.header ?? ""),
        multiSelect: q?.multiSelect === true,
        options: Array.isArray(q?.options)
            ? q.options.map((o) => ({
                label: String(o?.label ?? ""),
                description: String(o?.description ?? ""),
                preview: String(o?.preview ?? ""),
            }))
            : [],
    }));
}
/** Flatten a tool response into display text. */
export function stringifyToolResponse(resp) {
    if (resp === undefined || resp === null)
        return undefined;
    if (typeof resp === "string")
        return resp;
    if (typeof resp === "object") {
        if (typeof resp.stdout === "string" || typeof resp.stderr === "string") {
            const out = String(resp.stdout ?? "");
            const err = String(resp.stderr ?? "");
            return err ? (out ? `${out}\n${err}` : err) : out;
        }
        if (Array.isArray(resp.content)) {
            return resp.content
                .filter((b) => b?.type === "text")
                .map((b) => String(b.text ?? ""))
                .join("\n");
        }
        try {
            return JSON.stringify(resp);
        }
        catch {
            return String(resp);
        }
    }
    return String(resp);
}
/** AskUserQuestion tool_response to per-question answer map. */
export function extractQuestionAnswers(resp) {
    if (resp == null)
        return null;
    if (Array.isArray(resp)) {
        const out = {};
        resp.forEach((v, i) => { out[String(i)] = String(v ?? ""); });
        return out;
    }
    if (typeof resp === "object") {
        const rec = resp;
        if (rec.answers && typeof rec.answers === "object" && !Array.isArray(rec.answers)) {
            const out = {};
            for (const [k, v] of Object.entries(rec.answers)) {
                out[k] = typeof v === "string" ? v : JSON.stringify(v);
            }
            return out;
        }
        if (Array.isArray(rec.answers)) {
            const out = {};
            rec.answers.forEach((v, i) => { out[String(i)] = String(v ?? ""); });
            return out;
        }
        const out = {};
        for (const [k, v] of Object.entries(rec)) {
            out[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
        return out;
    }
    return { "0": String(resp) };
}
