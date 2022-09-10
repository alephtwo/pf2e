import { ErrorPF2e, fontAwesomeIcon, htmlQueryAll } from "@util";
import MiniSearch from "minisearch";

/** Extend CompendiumDirectory to support a search bar */
export class CompendiumDirectoryPF2e extends CompendiumDirectory {
    readonly searchEngine: MiniSearch<CompendiumIndexData>;

    constructor(options?: ApplicationOptions) {
        super(options);

        this.searchEngine = new MiniSearch<CompendiumIndexData>({
            fields: ["name"],
            idField: "_id",
            processTerm: (t) => (t.length > 1 ? t.toLocaleLowerCase(game.i18n.lang) : null),
            searchOptions: { combineWith: "AND", prefix: true },
            storeFields: ["img", "metadata", "name", "type"],
        });
        this.#compileSearchIndex();
    }

    /** Include ability to search and drag document search results */
    static override get defaultOptions(): ApplicationOptions {
        const options = super.defaultOptions;
        options.dragDrop.push({ dragSelector: "li[data-match-uuid]" });

        return {
            ...options,
            filters: [{ inputSelector: "input[type=search]", contentSelector: "ol.directory-list" }],
            template: "systems/pf2e/templates/sidebar/compendium-directory.html",
        };
    }

    /** Create a drag preview that looks like the one generated from an open compendium */
    get #dragPreview(): HTMLElement {
        const preview = document.createElement("div");
        preview.id = "pack-search-drag-preview";

        const thumbnail = document.createElement("img");
        const title = document.createElement("h4");
        preview.append(thumbnail, title);

        return preview;
    }

    override async getData(options?: Partial<ApplicationOptions>): Promise<CompendiumDirectoryDataPF2e> {
        return {
            ...(await super.getData(options)),
            searchContents: game.user.settings.searchPackContents,
        };
    }

    /* -------------------------------------------- */
    /*  Event Listeners and Handlers                */
    /* -------------------------------------------- */

    override activateListeners($html: JQuery): void {
        super.activateListeners($html);

        // Hook in the compendium browser
        $html[0]!.querySelector("footer > button")?.addEventListener("click", () => {
            game.pf2e.compendiumBrowser.render(true);
        });
    }

    /** Add a context menu for content search results */
    protected override _contextMenu($html: JQuery): void {
        super._contextMenu($html);

        ContextMenu.create(this, $html, "ol.doc-matches > li", [
            {
                name: "COMPENDIUM.ImportEntry",
                icon: fontAwesomeIcon("download").outerHTML,
                condition: ($li) => {
                    const { dataset } = $li.get(0) ?? {};
                    const collection = game.packs.get(dataset?.collection ?? "", { strict: true });
                    const documentClass = collection.documentClass as unknown as typeof foundry.abstract.Document;

                    return documentClass.canUserCreate(game.user);
                },
                callback: ($li) => {
                    const { dataset } = $li.get(0) ?? {};
                    if (!(dataset?.collection && dataset.documentId)) return;
                    const packCollection = game.packs.get(dataset.collection, { strict: true });
                    const worldCollection = game.collections.get(packCollection.documentName, { strict: true });

                    return worldCollection.importFromCompendium(
                        packCollection,
                        dataset.documentId,
                        {},
                        { renderSheet: true }
                    );
                },
            },
        ]);
    }

    /** System compendium search */
    protected override _onSearchFilter(_event: KeyboardEvent, query: string): void {
        // Match compendiums by title
        const matchesQuery = (pack: CompendiumCollection): boolean => {
            return pack.title.toLocaleLowerCase(game.i18n.lang).includes(query.toLocaleLowerCase(game.i18n.lang));
        };
        const filteredPacks = query.length > 0 ? game.packs.filter(matchesQuery) : game.packs.contents;
        const packRows = Array.from(
            this.element.get(0)?.querySelectorAll<HTMLOListElement>("li.compendium-pack") ?? []
        );

        // Display matching compendium rows along with any document matches within each compendium
        for (const pack of filteredPacks) {
            const packRow = packRows.find((r) => r.dataset.collection === pack.collection);
            if (!packRow || (pack.private && !game.user.isGM)) {
                continue;
            }
            packRow.style.display = "list-item";
            for (const dragDrop of this._dragDrop) {
                dragDrop.bind(packRow);
            }
        }

        // Hide the rest
        const rowsToHide =
            query.length > 0
                ? packRows.filter((r) => !filteredPacks.includes(game.packs.get(r.dataset.collection ?? "")!))
                : [];
        for (const row of rowsToHide) {
            row.style.display = "none";
        }

        // Match documents within each compendium by name
        const docMatches = query.length > 0 ? this.searchEngine.search(query) : [];
        if (docMatches.length === 0) return;

        // Create a list of document matches
        const matchTemplate = document.querySelector<HTMLTemplateElement>("#compendium-search-match");
        if (!matchTemplate) throw ErrorPF2e("Match template not found");

        for (const compendiumTypeList of htmlQueryAll(this.element[0]!, "li.compendium-type")) {
            const typedMatches = docMatches.filter((m) => m.metadata.type === compendiumTypeList.dataset.type);
            const listElements = typedMatches.map((match): HTMLLIElement => {
                const li = matchTemplate.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
                const matchUUID = `Compendium.${match.metadata.id}.${match.id}`;
                li.dataset.uuid = matchUUID;
                li.dataset.score = match.score.toString();

                // Show a thumbnail if available
                if (typeof match.img === "string") {
                    const thumbnail = li.querySelector("img")!;
                    thumbnail.src = match.img;
                }

                // Open compendium on result click
                li.addEventListener("click", async (event) => {
                    event.stopPropagation();
                    const doc = await fromUuid(matchUUID);
                    await doc?.sheet?.render(true);
                });

                const anchor = li.querySelector("a")!;
                anchor.innerText = match.name;
                const details = li.querySelector("span")!;
                const systemType =
                    match.metadata.type === "Actor"
                        ? game.i18n.localize(`ACTOR.Type${match.type.titleCase()}`)
                        : match.metadata.type === "Item"
                        ? game.i18n.localize(`ITEM.Type${match.type.titleCase()}`)
                        : null;
                details.innerText = systemType
                    ? `${systemType} (${match.metadata.label})`
                    : `(${match.metadata.label})`;

                return li;
            });

            compendiumTypeList.querySelector("ol.document-matches")?.replaceChildren(...listElements);
        }
    }

    /** Anyone can drag from search results */
    protected override _canDragStart(): boolean {
        return true;
    }

    /** Replicate the functionality of dragging a compendium document from an open `Compendium` */
    protected override _onDragStart(event: ElementDragEvent): void {
        const dragElement = event.currentTarget;
        const { collection, documentId } = dragElement.dataset;
        if (!(collection && documentId)) return;

        const pack = game.packs.get(collection, { strict: true });
        const indexEntry = pack?.index.get(documentId, { strict: true });

        // Clean up old drag preview
        document.querySelector("#pack-search-drag-preview")?.remove();

        // Create a new drag preview
        const dragPreview = this.#dragPreview.cloneNode(true) as HTMLElement;
        const [img, title] = Array.from(dragPreview.childNodes) as [HTMLImageElement, HTMLHeadingElement];
        title.innerText = indexEntry.name;
        if (indexEntry.img) img.src = indexEntry.img;

        document.body.appendChild(dragPreview);

        event.dataTransfer.setDragImage(dragPreview, 75, 25);
        event.dataTransfer.setData(
            "text/plain",
            JSON.stringify({
                type: pack.documentName,
                uuid: `Compendium.${pack.collection}.${documentId}`,
            })
        );
    }

    #compileSearchIndex(): void {
        console.debug("PF2e System | compiling search index");
        const packs = game.packs.filter(
            (p) => p.index.size > 0 && p.documentName !== "JournalEntry" && (game.user.isGM || !p.private)
        );

        for (const pack of packs) {
            const contents = pack.index.map((i) => ({
                ...i,
                metadata: pack.metadata,
            }));
            this.searchEngine.addAll(contents);
        }
        console.debug("PF2e System | Finished compiling search index");
    }
}

interface CompendiumDirectoryDataPF2e extends CompendiumDirectoryData {
    searchContents: boolean;
}
