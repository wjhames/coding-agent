export function inferVerificationCommands(args: {
  packageScripts: Record<string, string>;
}): string[] {
  const commands: string[] = [];

  if ("lint" in args.packageScripts) {
    commands.push("npm run lint");
  }

  if ("typecheck" in args.packageScripts) {
    commands.push("npm run typecheck");
  }

  if ("test" in args.packageScripts) {
    commands.push("npm test");
  }

  if ("check" in args.packageScripts) {
    commands.push("npm run check");
  }

  return commands;
}
