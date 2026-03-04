client.on("interactionCreate", async (interaction) => {
  if (!interaction.isAutocomplete()) return;

  try {
    const cmd = interaction.commandName;

    // Only handle autocomplete for these trader commands
    if (!["price", "buy", "sell", "pricesearch", "pricecategory"].includes(cmd)) return;

    const focused = interaction.options.getFocused(true); // { name, value }
    const typed = String(focused.value ?? "").trim().toLowerCase();

    // CATEGORY autocomplete
    if (cmd === "pricecategory" && focused.name === "category") {
      const cats = trader.categoryList || [];
      const matches = cats
        .filter((c) => c.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((c) => ({ name: c, value: c }));

      await interaction.respond(matches.length ? matches : cats.slice(0, 25).map((c) => ({ name: c, value: c })));
      return;
    }

    // ITEM autocomplete (price/buy/sell and pricesearch)
    if (["price", "buy", "sell", "pricesearch"].includes(cmd) && (focused.name === "item" || focused.name === "query")) {
      // Fast match over item keys/names
      const results = [];
      const max = 25;

      // If nothing typed, show some alphabetical starter suggestions
      if (!typed) {
        const some = Array.from(trader.itemsByKey.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, max)
          .map((it) => ({ name: it.name, value: it.name }));
        await interaction.respond(some);
        return;
      }

      for (const it of trader.itemsByKey.values()) {
        const nameLower = it.name.toLowerCase();
        if (!nameLower.includes(typed)) continue;

        // Show category in the dropdown label (nice UX)
        const label = it.category ? `${it.name} • ${it.category}` : it.name;

        results.push({ name: label.slice(0, 100), value: it.name }); // name max ~100 chars
        if (results.length >= max) break;
      }

      await interaction.respond(results);
      return;
    }
  } catch (e) {
    // Never throw in autocomplete; just fail silently to avoid breaking commands
    console.error("[AUTOCOMPLETE] error:", e?.message ?? e);
    try { await interaction.respond([]); } catch {}
  }
});
