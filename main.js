/*
 * Multi-Tag Node Colors — plugin Obsidian
 *
 * Colore les nœuds du graphe en "camembert" quand une note correspond à
 * plusieurs groupes de couleurs de type `tag:#xxx` définis dans les réglages
 * du graphe (Graphe > Groupes).
 *
 * Le graphe d'Obsidian n'a pas d'API publique : ce plugin s'appuie sur des
 * objets internes (view.renderer.nodes, node.circle, engine.getOptions()).
 * Une mise à jour d'Obsidian peut les casser.
 */
const { Plugin, PluginSettingTab, Setting, TFile, getAllTags } = require("obsidian");

const PIE_KEY = "__mtncPie";
const PIE_NAME = "mtnc-pie";
const TICK_MS = 300;

const DEFAULT_SETTINGS = {
	matchSubtags: true,   // #windows correspond aussi à #windows/server
	separatorWidth: 0,    // épaisseur du trait entre les parts (0 = aucun), en % du rayon
	startAngle: -90,      // angle de départ en degrés (-90 = en haut)
};

class MultiTagNodeColorsPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.viewStates = new WeakMap();   // vue -> { sig, cache: Map<id, couleurs> }
		this.renderers = new Set();        // renderers touchés (pour le nettoyage)
		this.dirty = new Set();            // chemins de notes modifiées
		this.textureCache = new Map();     // fallback Sprite : signature -> texture
		this.pixi = null;                  // { Graphics?, Sprite?, Texture? }

		this.addSettingTab(new MultiTagSettingTab(this.app, this));

		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.dirty.add(file.path)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			this.dirty.add(file.path);
			this.dirty.add(oldPath);
		}));

		this.addCommand({
			id: "refresh",
			name: "Rafraîchir les nœuds multi-tags",
			callback: () => this.resetAll(),
		});

		this.app.workspace.onLayoutReady(() => {
			this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
		});
	}

	onunload() {
		this.resetAll(true);
		for (const tex of this.textureCache.values()) {
			try { tex.destroy(true); } catch (e) { /* ignore */ }
		}
		this.textureCache.clear();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.resetAll();
	}

	// ------------------------------------------------------------------ boucle

	getGraphViews() {
		const ws = this.app.workspace;
		return [...ws.getLeavesOfType("graph"), ...ws.getLeavesOfType("localgraph")]
			.map((leaf) => leaf.view)
			.filter((view) => view && view.renderer && Array.isArray(view.renderer.nodes));
	}

	tick() {
		for (const view of this.getGraphViews()) {
			try {
				this.processView(view);
			} catch (e) {
				console.error("[multi-tag-node-colors]", e);
			}
		}
		this.dirty.clear();
	}

	processView(view) {
		const renderer = view.renderer;
		this.renderers.add(renderer);

		const groups = this.getTagGroups(view);
		const sig = JSON.stringify(groups) + "|" + JSON.stringify(this.settings);

		let state = this.viewStates.get(view);
		if (!state || state.sig !== sig) {
			this.clearRenderer(renderer);
			state = { sig, cache: new Map() };
			this.viewStates.set(view, state);
		}

		let changed = false;
		for (const node of renderer.nodes) {
			const circle = node.circle;
			if (!circle || circle.destroyed) continue;
			if (node.type !== "" && node.type !== "focused") continue; // notes uniquement

			const isDirty = this.dirty.has(node.id);
			if (isDirty) state.cache.delete(node.id);

			const current = circle[PIE_KEY];
			const attached = current && current.id === node.id &&
				(current.g === null || (!current.g.destroyed && current.g.parent === circle));
			if (attached && !isDirty) continue;

			if (current) {
				this.detach(circle);
				changed = true;
			}

			let colors = state.cache.get(node.id);
			if (!colors) {
				colors = this.colorsForNode(node, groups);
				state.cache.set(node.id, colors);
			}

			if (colors.length < 2) {
				circle[PIE_KEY] = { id: node.id, g: null };
				continue;
			}

			const g = this.makePie(circle, colors, renderer);
			if (g) {
				circle.addChild(g);
				circle[PIE_KEY] = { id: node.id, g };
				changed = true;
			}
		}

		if (changed && typeof renderer.changed === "function") renderer.changed();
	}

	resetAll(final = false) {
		for (const renderer of this.renderers) {
			try { this.clearRenderer(renderer); } catch (e) { /* ignore */ }
		}
		if (final) this.renderers.clear();
		this.viewStates = new WeakMap();
	}

	clearRenderer(renderer) {
		if (!renderer || !Array.isArray(renderer.nodes)) return;
		for (const node of renderer.nodes) {
			if (node.circle) this.detach(node.circle);
		}
		if (typeof renderer.changed === "function") renderer.changed();
	}

	detach(circle) {
		const current = circle[PIE_KEY];
		if (current && current.g) {
			try {
				if (current.g.parent) current.g.parent.removeChild(current.g);
				current.g.destroy({ children: true, texture: false, baseTexture: false });
			} catch (e) { /* ignore */ }
		}
		delete circle[PIE_KEY];
	}

	// --------------------------------------------------------------- données

	/** Groupes de couleurs du graphe dont la requête est un simple `tag:#xxx`. */
	getTagGroups(view) {
		const engine = view.dataEngine || view.engine;
		let options = null;
		if (engine) {
			options = typeof engine.getOptions === "function" ? engine.getOptions() : engine.options;
		}
		const raw = (options && Array.isArray(options.colorGroups)) ? options.colorGroups : [];
		const groups = [];
		for (const grp of raw) {
			if (!grp || typeof grp.query !== "string" || !grp.color) continue;
			const m = grp.query.trim().match(/^tag:\s*"?#?([^\s"()]+)"?$/i);
			if (!m) continue;
			groups.push({
				tag: m[1].toLowerCase(),
				rgb: grp.color.rgb,
				a: typeof grp.color.a === "number" ? grp.color.a : 1,
			});
		}
		return groups;
	}

	colorsForNode(node, groups) {
		if (groups.length < 2) return [];
		const file = this.app.vault.getAbstractFileByPath(node.id);
		if (!(file instanceof TFile)) return [];
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return [];
		const tags = (getAllTags(cache) || []).map((t) => t.replace(/^#/, "").toLowerCase());
		if (tags.length === 0) return [];

		const colors = [];
		const seen = new Set();
		for (const grp of groups) {
			if (seen.has(grp.tag)) continue;
			const match = tags.some((t) =>
				t === grp.tag || (this.settings.matchSubtags && t.startsWith(grp.tag + "/")));
			if (match) {
				seen.add(grp.tag);
				colors.push({ rgb: grp.rgb, a: grp.a });
			}
		}
		return colors;
	}

	// ---------------------------------------------------------------- dessin

	/** Récupère les classes PIXI utilisées par Obsidian, sans les embarquer. */
	resolvePixi(circle, renderer) {
		if (this.pixi) return this.pixi;
		const found = {};
		const PIXI = window.PIXI;
		if (PIXI && PIXI.Graphics) {
			found.Graphics = PIXI.Graphics;
			found.Sprite = PIXI.Sprite;
			found.Texture = PIXI.Texture;
		}
		const isGraphics = (o) => o && typeof o.beginFill === "function" && typeof o.arc === "function";
		if (!found.Graphics && isGraphics(circle)) found.Graphics = circle.constructor;
		if (!found.Graphics) {
			const root = (renderer.px && renderer.px.stage) || renderer.hanger;
			const stack = root ? [root] : [];
			let visited = 0;
			while (stack.length && visited < 5000 && !found.Graphics) {
				const obj = stack.pop();
				visited++;
				if (isGraphics(obj)) { found.Graphics = obj.constructor; break; }
				if (obj && Array.isArray(obj.children)) stack.push(...obj.children);
			}
		}
		if (!found.Graphics) {
			// Fallback : Sprite + texture dessinée sur un canvas
			if (circle.texture && circle.anchor) found.Sprite = circle.constructor;
			else {
				const text = renderer.nodes.find((n) => n.text && n.text.texture);
				if (text) found.Sprite = Object.getPrototypeOf(text.text.constructor.prototype).constructor;
			}
			const withTex = circle.texture ? circle : renderer.nodes.map((n) => n.text).find((t) => t && t.texture);
			if (withTex) found.Texture = withTex.texture.constructor;
		}
		this.pixi = found;
		return found;
	}

	/** Centre et rayon du cercle du nœud, dans son repère local. */
	geometryOf(circle) {
		try {
			if (circle.texture && circle.anchor) {
				const w = (circle.texture.orig && circle.texture.orig.width) || circle.texture.width;
				const h = (circle.texture.orig && circle.texture.orig.height) || circle.texture.height;
				if (w > 0) {
					return { cx: (0.5 - circle.anchor.x) * w, cy: (0.5 - circle.anchor.y) * h, r: Math.min(w, h) / 2 };
				}
			}
			// Le premier cercle est le disque visible. Sur mobile, Obsidian en ajoute
			// un second, invisible et 5 fois plus grand, qui fausse les bornes.
			const first = circle.geometry && circle.geometry.graphicsData && circle.geometry.graphicsData[0];
			if (first && first.shape && first.shape.radius > 0) {
				return { cx: first.shape.x, cy: first.shape.y, r: first.shape.radius };
			}
			if (circle.geometry && circle.geometry.bounds) {
				const b = circle.geometry.bounds;
				const w = b.maxX - b.minX, h = b.maxY - b.minY;
				if (isFinite(w) && w > 0) {
					return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, r: Math.min(w, h) / 2 };
				}
			}
			const lb = circle.getLocalBounds();
			if (lb && lb.width > 0) {
				return { cx: lb.x + lb.width / 2, cy: lb.y + lb.height / 2, r: Math.min(lb.width, lb.height) / 2 };
			}
		} catch (e) { /* ignore */ }
		return { cx: 0, cy: 0, r: 100 };
	}

	makePie(circle, colors, renderer) {
		const pixi = this.resolvePixi(circle, renderer);
		const geo = this.geometryOf(circle);
		const n = colors.length;
		const step = (2 * Math.PI) / n;
		const start = (this.settings.startAngle * Math.PI) / 180;
		const sepRatio = Math.max(0, this.settings.separatorWidth) / 100;
		const bg = this.backgroundColor();

		let obj = null;
		if (pixi.Graphics) {
			const g = new pixi.Graphics();
			for (let i = 0; i < n; i++) {
				const a0 = start + i * step, a1 = a0 + step;
				g.beginFill(colors[i].rgb, colors[i].a);
				g.moveTo(0, 0);
				g.arc(0, 0, geo.r, a0, a1);
				g.lineTo(0, 0);
				g.endFill();
			}
			if (sepRatio > 0) {
				g.lineStyle(geo.r * sepRatio, bg.rgb, 1);
				for (let i = 0; i < n; i++) {
					const a = start + i * step;
					g.moveTo(0, 0);
					g.lineTo(Math.cos(a) * geo.r, Math.sin(a) * geo.r);
				}
			}
			g.position.set(geo.cx, geo.cy);
			obj = g;
		} else if (pixi.Sprite && pixi.Texture && typeof pixi.Texture.from === "function") {
			const tex = this.pieTexture(pixi.Texture, colors, start, sepRatio, bg.css);
			const s = new pixi.Sprite(tex);
			s.anchor.set(0.5);
			s.width = s.height = geo.r * 2;
			s.position.set(geo.cx, geo.cy);
			obj = s;
		} else {
			return null;
		}

		obj.name = PIE_NAME;
		obj.eventMode = "none";
		obj.interactive = false;
		obj.interactiveChildren = false;
		return obj;
	}

	pieTexture(Texture, colors, start, sepRatio, bgCss) {
		const key = colors.map((c) => c.rgb + ":" + c.a).join(",") + "|" + start + "|" + sepRatio + "|" + bgCss;
		let tex = this.textureCache.get(key);
		if (tex) return tex;
		const R = 128;
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = R * 2;
		const ctx = canvas.getContext("2d");
		const step = (2 * Math.PI) / colors.length;
		colors.forEach((c, i) => {
			ctx.beginPath();
			ctx.moveTo(R, R);
			ctx.arc(R, R, R, start + i * step, start + (i + 1) * step);
			ctx.closePath();
			ctx.globalAlpha = c.a;
			ctx.fillStyle = "#" + (c.rgb >>> 0).toString(16).padStart(6, "0");
			ctx.fill();
		});
		ctx.globalAlpha = 1;
		if (sepRatio > 0) {
			ctx.strokeStyle = bgCss;
			ctx.lineWidth = R * sepRatio;
			colors.forEach((_, i) => {
				const a = start + i * step;
				ctx.beginPath();
				ctx.moveTo(R, R);
				ctx.lineTo(R + Math.cos(a) * R, R + Math.sin(a) * R);
				ctx.stroke();
			});
		}
		tex = Texture.from(canvas);
		this.textureCache.set(key, tex);
		return tex;
	}

	backgroundColor() {
		const raw = getComputedStyle(document.body).getPropertyValue("--background-primary").trim() || "#000000";
		const ctx = document.createElement("canvas").getContext("2d");
		ctx.fillStyle = raw;
		const css = ctx.fillStyle; // normalisé en #rrggbb ou rgba(...)
		let rgb = 0;
		if (css.startsWith("#")) rgb = parseInt(css.slice(1, 7), 16);
		else {
			const m = css.match(/\d+/g);
			if (m) rgb = (Number(m[0]) << 16) | (Number(m[1]) << 8) | Number(m[2]);
		}
		return { rgb, css };
	}
}

class MultiTagSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			text: "Les couleurs viennent des groupes définis dans les réglages du graphe " +
				"(Graphe > Groupes). Seuls les groupes dont la requête est un simple tag " +
				"(par ex. tag:#windows) sont pris en compte. L'ordre des parts suit l'ordre des groupes.",
		});

		new Setting(containerEl)
			.setName("Inclure les sous-tags")
			.setDesc("Le groupe tag:#windows colore aussi les notes taguées #windows/server.")
			.addToggle((t) => t
				.setValue(this.plugin.settings.matchSubtags)
				.onChange(async (v) => {
					this.plugin.settings.matchSubtags = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Séparateur entre les parts")
			.setDesc("Épaisseur du trait (couleur du fond) entre les parts, en % du rayon. 0 = aucun.")
			.addSlider((s) => s
				.setLimits(0, 20, 1)
				.setDynamicTooltip()
				.setValue(this.plugin.settings.separatorWidth)
				.onChange(async (v) => {
					this.plugin.settings.separatorWidth = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Angle de départ")
			.setDesc("Position de la première part, en degrés (-90 = en haut, 0 = à droite).")
			.addSlider((s) => s
				.setLimits(-180, 180, 15)
				.setDynamicTooltip()
				.setValue(this.plugin.settings.startAngle)
				.onChange(async (v) => {
					this.plugin.settings.startAngle = v;
					await this.plugin.saveSettings();
				}));
	}
}

module.exports = MultiTagNodeColorsPlugin;
