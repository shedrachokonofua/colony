export default async () => {
  const tmp = process.env.COLONY_E2E_TMP_DIR;
  if (tmp)
    await import("node:fs").then((f) =>
      f.rmSync(tmp, { recursive: true, force: true }),
    );
};
