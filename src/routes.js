import path from "node:path";

const BUILTIN_ROUTES = Object.freeze({
  general: {
    description: "General fallback for mixed or ambiguous tasks.",
    promptFile: "./src/prompts/general.md",
    keywords: [],
  },
  research: {
    description: "Research, papers, literature review, source comparison, and evidence-heavy work.",
    promptFile: "./src/prompts/research.md",
    keywords: [
      "research",
      "paper",
      "papers",
      "literature",
      "citation",
      "citations",
      "reference",
      "references",
      "academic",
      "journal",
      "arxiv",
      "论文",
      "文献",
      "参考文献",
      "引文",
      "研究",
      "学术",
      "综述",
    ],
  },
  code_mod: {
    description: "Code changes, bug fixing, implementation, debugging, and verification.",
    promptFile: "./src/prompts/code_mod.md",
    keywords: [
      "bug",
      "fix",
      "patch",
      "refactor",
      "refactoring",
      "implement",
      "implementation",
      "code",
      "function",
      "class",
      "typescript",
      "javascript",
      "python",
      "rust",
      "go",
      "test",
      "tests",
      "代码",
      "修复",
      "重构",
      "实现",
      "函数",
      "类",
      "测试",
      "报错",
      "异常",
    ],
  },
  writing: {
    description: "Writing, rewriting, polishing, structuring prose, and documentation quality.",
    promptFile: "./src/prompts/writing.md",
    keywords: [
      "write",
      "rewrite",
      "polish",
      "draft",
      "article",
      "essay",
      "blog",
      "copy",
      "document",
      "documentation",
      "readme",
      "memo",
      "writing",
      "写",
      "改写",
      "润色",
      "文案",
      "文章",
      "博客",
      "说明文档",
      "README",
      "备忘录",
    ],
  },
  data_collection: {
    description: "Data gathering, scraping, extraction, APIs, datasets, and collection workflows.",
    promptFile: "./src/prompts/data_collection.md",
    keywords: [
      "collect data",
      "scrape",
      "crawl",
      "dataset",
      "csv",
      "json",
      "api",
      "fetch",
      "search web",
      "browse",
      "gather",
      "数据收集",
      "抓取",
      "爬取",
      "数据集",
      "接口",
      "获取数据",
      "网页搜索",
      "检索数据",
    ],
  },
});

export function normalizeRouteName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  if (!normalized) {
    return null;
  }
  return normalized;
}

function normalizeKeywords(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const result = [];
  const seen = new Set();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const keyword = item.trim();
    if (!keyword || seen.has(keyword)) {
      continue;
    }
    seen.add(keyword);
    result.push(keyword);
  }

  return result;
}

function normalizePromptFile(pluginRoot, routeName, promptFile) {
  const fallback = `./src/prompts/${routeName}.md`;
  const raw = typeof promptFile === "string" && promptFile.trim().length > 0 ? promptFile.trim() : fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(pluginRoot, raw);
}

export function resolveRoutes(pluginRoot, rawRoutes) {
  const routes = {};

  for (const [routeName, routeConfig] of Object.entries(BUILTIN_ROUTES)) {
    routes[routeName] = {
      name: routeName,
      description: routeConfig.description,
      promptFile: normalizePromptFile(pluginRoot, routeName, routeConfig.promptFile),
      keywords: normalizeKeywords(routeConfig.keywords),
    };
  }

  if (rawRoutes && typeof rawRoutes === "object" && !Array.isArray(rawRoutes)) {
    for (const [rawName, rawConfig] of Object.entries(rawRoutes)) {
      const routeName = normalizeRouteName(rawName);
      if (!routeName) {
        continue;
      }

      if (rawConfig && typeof rawConfig === "object" && rawConfig.enabled === false) {
        delete routes[routeName];
        continue;
      }

      const base = routes[routeName] ?? {
        name: routeName,
        description: `Custom route: ${routeName}`,
        promptFile: normalizePromptFile(pluginRoot, routeName, undefined),
        keywords: [],
      };

      const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
      routes[routeName] = {
        name: routeName,
        description:
          typeof config.description === "string" && config.description.trim().length > 0
            ? config.description.trim()
            : base.description,
        promptFile: normalizePromptFile(pluginRoot, routeName, config.promptFile ?? base.promptFile),
        keywords:
          Array.isArray(config.keywords)
            ? normalizeKeywords(config.keywords)
            : base.keywords,
      };
    }
  }

  if (!routes.general) {
    routes.general = {
      name: "general",
      description: BUILTIN_ROUTES.general.description,
      promptFile: normalizePromptFile(pluginRoot, "general", BUILTIN_ROUTES.general.promptFile),
      keywords: [],
    };
  }

  return routes;
}

export function listRouteNames(routes) {
  return Object.keys(routes);
}

export function listRouteDescriptions(routes) {
  return Object.fromEntries(
    Object.entries(routes).map(([routeName, routeConfig]) => [routeName, routeConfig.description]),
  );
}
