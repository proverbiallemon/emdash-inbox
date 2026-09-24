/** Only typography: no URLs, custom properties, positioning, or page styling. */
export function safeMailStyle(raw = ""): string {
	const color = /^(?:#[\da-f]{3,8}|[a-z]{1,20}|(?:rgb|rgba|hsl|hsla)\([\d.,%\s+-]+\))$/i;
	return raw.split(";").flatMap(declaration => {
		const index = declaration.indexOf(":");
		const property = declaration.slice(0, index).trim().toLowerCase();
		const value = declaration.slice(index + 1).trim();
		let allowed = false;
		if (["color", "background-color"].includes(property)) allowed = color.test(value);
		if (property === "font-family") allowed = value.length <= 160 && /^[a-z][a-z0-9\s,'"-]*$/i.test(value.replace(/^['"]/, ""));
		if (property === "font-size") {
			const size = /^(\d+(?:\.\d+)?)(px|pt|em|rem|%)$/.exec(value);
			if (size) { const n = Number(size[1]); const unit = size[2]; allowed = n >= (unit === "%" ? 50 : unit === "em" || unit === "rem" ? .5 : 8) && n <= (unit === "%" ? 300 : unit === "em" || unit === "rem" ? 3 : unit === "pt" ? 36 : 48); }
		}
		if (property === "text-align") allowed = /^(left|center|right|justify)$/.test(value);
		if (property === "font-weight") allowed = /^(normal|bold|[1-9]00)$/.test(value);
		if (property === "font-style") allowed = /^(normal|italic)$/.test(value);
		if (property === "text-decoration") allowed = /^(none|underline|line-through)( (underline|line-through))?$/.test(value);
		return allowed ? [`${property}:${value}`] : [];
	}).join(";");
}
