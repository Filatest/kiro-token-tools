export async function onRequest(context) {
  const { request } = context;

  // CORS 处理
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders()
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    console.error("JSON parse error:", e);
    return json({ error: "Invalid JSON body" }, 400);
  }

  const input = (body?.input ?? "").toString().trim();
  if (!input) return json({ error: "Empty input" }, 400);

  try {
    // 1) 解析输入
    const parsed = parseInput(input);
    if (!parsed?.refreshToken) {
      return json({ error: "未识别到 refreshToken，请检查粘贴内容格式" }, 400);
    }

    const region = parsed.region || "us-east-1";
    const isBuilderIdType =
      parsed.provider?.toLowerCase() === "builderid" ||
      (!!parsed.clientId && !!parsed.clientSecret);

    // 2) 刷新/换取 accessToken
    let tokenResp;
    if (isBuilderIdType) {
      if (!parsed.clientId || !parsed.clientSecret) {
        return json({ error: "BuilderId 账号缺少 clientId / clientSecret" }, 400);
      }
      tokenResp = await refreshBuilderIdToken({
        refreshToken: parsed.refreshToken,
        clientId: parsed.clientId,
        clientSecret: parsed.clientSecret,
        region,
      });
    } else {
      tokenResp = await refreshSocialToken({
        refreshToken: parsed.refreshToken,
        accessToken: parsed.accessToken,
        profileArn: parsed.profileArn,
      });
    }

    if (!tokenResp?.accessToken) {
      return json({ error: "刷新 accessToken 失败（refreshToken 可能无效或已过期）" }, 400);
    }

    // 3) 组装 kiro-auth-token.json
    const kiroToken = {
      accessToken: tokenResp.accessToken,
      refreshToken: parsed.refreshToken,
      authMethod: isBuilderIdType ? "builderid" : "social",
      provider: parsed.provider || "Google",
      expiresAt: tokenResp.expiresAt || inferExpiresAt(tokenResp),
      ...(parsed.clientId || tokenResp.clientId) && { clientId: parsed.clientId || tokenResp.clientId },
      ...(parsed.clientSecret || tokenResp.clientSecret) && { clientSecret: parsed.clientSecret || tokenResp.clientSecret },
      ...parsed.profileArn && { profileArn: parsed.profileArn },
    };

    // 4) BuilderId：生成第二个文件（clientIdHash 文件）
    let clientIdHashFile = null;
    if (isBuilderIdType && (parsed.clientId || tokenResp.clientId)) {
      const clientId = parsed.clientId || tokenResp.clientId;
      const hash = await sha1Hex(clientId);
      clientIdHashFile = {
        filename: `${hash}.json`,
        content: {
          clientId: clientId,
          clientSecret: parsed.clientSecret || tokenResp.clientSecret,
          region,
        },
      };
    }

    // 5) 用量查询
    const usageResult = await fetchUsageFromKiro({
      accessToken: tokenResp.accessToken,
      region,
    });

    // 确保 email 信息正确传递
    let finalUsage = usageResult.usage;
    if (!finalUsage) {
      finalUsage = {
        limit: "-",
        used: "-", 
        remaining: "-",
        email: parsed.email || null,
        note: "用量查询失败，可能是 Token 已过期或权限不足"
      };
    } else {
      // 如果用量查询成功但没有email，尝试使用解析出的email
      if (!finalUsage.email && parsed.email) {
        finalUsage.email = parsed.email;
      }
    }

    return json({
      usage: finalUsage,
      kiroToken,
      isBuilderIdType,
      clientIdHashFile,
    });
  } catch (e) {
    console.error("API Error:", e);
    return json({ 
      error: e?.message || "Server Error",
      details: e?.stack || "No stack trace available"
    }, 500);
  }
}

/* ------------------------ helpers ------------------------ */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/* ------------------------ token refresh ------------------------ */

async function refreshSocialToken({ refreshToken, accessToken, profileArn }) {
  // 如果已有有效的 accessToken，直接使用
  if (accessToken && !accessToken.startsWith('aor')) {
    return {
      accessToken: accessToken,
      expiresAt: null,
      expiresIn: null,
    };
  }

  // 尝试通过 Kiro 服务刷新 Token
  try {
    const r = await fetch("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "KiroTokenTools/1.0 (+Cloudflare)",
      },
      body: JSON.stringify({ 
        refreshToken: refreshToken,
        profileArn: profileArn 
      }),
    });

    if (r.ok) {
      const data = await r.json();
      if (data.accessToken || data.access_token) {
        return {
          accessToken: data.accessToken || data.access_token,
          expiresAt: data.expiresAt,
          expiresIn: data.expiresIn || data.expires_in,
        };
      }
    }
  } catch (e) {
    console.log("Kiro token refresh failed:", e.message);
  }

  // 回退：直接使用 refreshToken 作为 accessToken
  return {
    accessToken: refreshToken,
    expiresAt: null,
    expiresIn: null,
  };
}

async function refreshBuilderIdToken({ refreshToken, clientId, clientSecret, region }) {
  const url = `https://oidc.${region}.amazonaws.com/token`;

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "KiroTokenTools/1.0 (+Cloudflare)",
    },
    body: form.toString(),
  });

  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}

  if (!r.ok) {
    throw new Error(`BuilderId refresh 失败：HTTP ${r.status} ${data?.error_description || data?.error || text}`);
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    clientId,
    clientSecret,
  };
}

/* ------------------------ usage query ------------------------ */

async function fetchUsageFromKiro({ accessToken, region }) {
  try {
    const r = await fetch(`https://q.${region}.amazonaws.com/getUsageLimits`, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": "aws-sdk-js/1.0.0 KiroTokenTools/1.0 (+Cloudflare)",
        "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroTokenTools/1.0",
      },
    });

    if (r.ok) {
      const rawData = await r.json();
      const usage = normalizeUsage(rawData);
      if (usage) {
        console.log("Usage query successful, email:", usage.email); // 调试日志
        return { usage };
      }
    } else {
      console.log("Usage query failed with status:", r.status);
    }
  } catch (e) {
    console.log("AWS usage query failed:", e.message);
  }
  return { usage: null };
}

function normalizeUsage(data) {
  console.log("Raw usage data:", JSON.stringify(data, null, 2)); // 调试日志
  
  if (!data?.usageBreakdownList?.[0]) return null;
  
  const usage = data.usageBreakdownList[0];
  const freeTrialInfo = usage.freeTrialInfo;
  
  // 计算合并用量（试用期 + 正式版）
  let totalLimit = usage.usageLimit || usage.usageLimitWithPrecision || 0;
  let totalUsed = usage.currentUsage || usage.currentUsageWithPrecision || 0;
  
  // 如果有激活的试用期，加入试用期用量
  if (freeTrialInfo?.freeTrialStatus === "ACTIVE") {
    totalLimit += freeTrialInfo.usageLimit || freeTrialInfo.usageLimitWithPrecision || 0;
    totalUsed += freeTrialInfo.currentUsage || freeTrialInfo.currentUsageWithPrecision || 0;
  }
  
  // 尝试从多个可能的位置获取email
  const email = data.userInfo?.email || 
                data.email || 
                usage.userInfo?.email || 
                usage.email ||
                null;
  
  console.log("Extracted email:", email); // 调试日志
  
  return {
    limit: totalLimit,
    used: totalUsed,
    remaining: totalLimit - totalUsed,
    email: email,
  };
}

/* ------------------------ input parsing ------------------------ */

function parseInput(input) {
  // 纯 refreshToken 格式（aor 开头）
  if (/^aor[A-Za-z0-9_+-]{50,}:[A-Za-z0-9+/=]{50,}$/.test(input)) {
    return { refreshToken: input };
  }

  // 直接 JSON
  try {
    const parsed = JSON.parse(input);
    if (parsed.refreshToken) return parsed;
  } catch {}

  // 中文格式：账号：{...}登录token：{...}
  try {
    const [, account] = input.match(/账号：\s*(\{[^}]+\})/) || [];
    const [, token] = input.match(/登录token：\s*(\{[^}]+\})/) || [];
    if (account && token) {
      return { ...JSON.parse(account), ...JSON.parse(token) };
    }
  } catch {}

  // 管道格式：{...}|{...}
  if (input.includes('|')) {
    try {
      const [part1, part2] = input.split('|').map(p => JSON.parse(p.trim()));
      return { ...part1, ...part2 };
    } catch {}
  }

  return null;
}

function inferExpiresAt(tokenResp) {
  if (tokenResp.expiresIn) {
    return new Date(Date.now() + tokenResp.expiresIn * 1000).toISOString();
  }
  return new Date(Date.now() + 3600 * 1000).toISOString();
}

async function sha1Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-1", enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}