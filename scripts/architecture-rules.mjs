import path from "node:path"

// Resolve both aliases and relative paths; type-only imports obey the same boundary.
export const domainBoundaries = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      infrastructure:
        "Application and domain modules depend on capabilities. Provide adapters at a host composition root.",
      runner:
        "Run Effects at host boundaries; compose them inside application services.",
      errorIdentity:
        "Application and domain code use typed tags or decoded error contracts, not class prototypes.",
      sharedDependency:
        "Shared mechanisms cannot depend on a feature. Import the feature's contract from its owner.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/")
    const root = filename.slice(0, filename.lastIndexOf("/src/"))
    function check(node, source) {
      if (typeof source !== "string") return
      const resolved = source.startsWith("@/")
        ? path.resolve(root, "src", source.slice(2))
        : source.startsWith(".")
          ? path.resolve(path.dirname(filename), source)
          : source
      if (
        /\/src\/shared\//.test(filename) &&
        /\/src\/(?!shared\/)[^/]+\//.test(resolved)
      )
        context.report({ node, messageId: "sharedDependency" })
      if (
        /\/src\/[^/]+\/adapters\//.test(resolved) ||
        /\/src\/(agent|storage)\//.test(resolved) ||
        /\/src\/(?:env|auth\/(?:server|client|schema))(?:\.[cm]?[jt]s)?$/.test(
          resolved
        ) ||
        /\/(?:alchemy\.run(?:\.[cm]?[jt]s)?|stacks\/.*)$/.test(resolved) ||
        /\/src\/[^/]+\/worker(?:\.[cm]?[jt]s)?$/.test(resolved) ||
        /^(cloudflare:|node:|bun:|@cloudflare\/|@earendil-works\/|@effect\/(?:platform-|sql-)|agents(?:\/|$)|alchemy(?:\/|$))/.test(
          resolved
        )
      )
        context.report({ node, messageId: "infrastructure" })
    }
    function importedPath(node) {
      if (node.type === "Identifier") {
        let scope = context.sourceCode.getScope(node)
        while (scope) {
          const binding = scope.set.get(node.name)
          if (binding) {
            const definition = binding.defs.find(
              (value) => value.type === "ImportBinding"
            )
            if (!definition) return
            const specifier = definition.node
            return {
              source: definition.parent.source.value,
              members:
                specifier.type === "ImportNamespaceSpecifier"
                  ? []
                  : [specifier.imported?.name ?? specifier.imported?.value],
            }
          }
          scope = scope.upper
        }
      }
      if (node.type === "MemberExpression") {
        const base = importedPath(node.object)
        const name = node.computed ? node.property.value : node.property.name
        if (base && typeof name === "string")
          return { ...base, members: [...base.members, name] }
      }
    }
    function runsEffect(node) {
      const imported = importedPath(node)
      if (imported) {
        const members =
          imported.source === "effect"
            ? imported.members
            : imported.source === "effect/Effect"
              ? ["Effect", ...imported.members]
              : imported.source === "effect/ManagedRuntime"
                ? ["ManagedRuntime", ...imported.members]
                : []
        return (
          members.length === 2 &&
          ((members[0] === "Effect" && /^run/.test(members[1])) ||
            (members[0] === "ManagedRuntime" && members[1] === "make"))
        )
      }
      return false
    }
    return {
      MemberExpression(node) {
        if (
          (!node.computed &&
            node.property.type === "Identifier" &&
            node.property.name === "webSocket") ||
          (node.computed && node.property.value === "webSocket")
        )
          context.report({ node, messageId: "infrastructure" })
      },
      BinaryExpression(node) {
        if (node.operator === "instanceof")
          context.report({ node, messageId: "errorIdentity" })
      },
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) =>
        node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => check(node, node.source.value),
      CallExpression(node) {
        if (runsEffect(node.callee)) {
          context.report({ node, messageId: "runner" })
        }
      },
    }
  },
}
