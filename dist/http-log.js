export function redactTokenQueryParam(url) {
    const queryIndex = url.indexOf("?");
    if (queryIndex === -1)
        return url;
    const params = new URLSearchParams(url.slice(queryIndex + 1));
    if (!params.has("token"))
        return url;
    const redacted = new URLSearchParams();
    for (const [name, value] of params) {
        redacted.append(name, name === "token" ? "REDACTED" : value);
    }
    return `${url.slice(0, queryIndex)}?${redacted.toString()}`;
}
