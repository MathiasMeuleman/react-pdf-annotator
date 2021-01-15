import React, {Component, ComponentType, createRef, CSSProperties, RefObject} from "react";
import {Document, pdfjs} from "react-pdf";
import "react-pdf/dist/esm/Page/AnnotationLayer.css";
import "../style/react_pdf_viewer.css";
import {NormalizedAreaSelection, NormalizedTextSelection, SelectionType} from "../types";
import {generateUuid, getBoundingRect, getClientRects, getPageFromRange, getWindow} from "../utils";
import {normalizePosition} from "../utils/coordinates";
import {AreaSelectionProps} from "./AreaSelection";
import {NewAreaSelectionProps} from "./NewAreaSelection";
import {PdfPage} from "./PdfPage";
import {PlaceholderPage} from "./PlaceholderPage";
import {TextSelectionProps} from "./TextSelection";

interface PdfViewerProps {
    url: string;
    selections?: Array<SelectionType>;
    enableAreaSelection?: (event: React.MouseEvent) => boolean;
    onTextSelection?: (highlightTip?: NormalizedTextSelection) => void;
    onAreaSelection?: (highlightTip?: NormalizedAreaSelection) => void;
    textSelectionColor?: CSSProperties["color"];
    textSelectionComponent?: ComponentType<TextSelectionProps>;
    areaSelectionComponent?: ComponentType<AreaSelectionProps>;
    newAreaSelectionComponent?: ComponentType<NewAreaSelectionProps>;
}

interface PdfViewerState {
    documentUuid?: string;
    textSelectionEnabled: boolean;
    areaSelectionActivePage?: number;
    numPages: number;
    pageDimensions?: Map<number, { width: number; height: number }>;
    pageYOffsets?: number[];
    visiblePages?: number[];
}

pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

export class PdfViewer extends Component<PdfViewerProps, PdfViewerState> {
    state: PdfViewerState = {
        textSelectionEnabled: true,
        numPages: 0,
    };

    /** Total left and right border width, needed as offset to avoid PageCanvas rendering past right page border. */
    BORDER_WIDTH_OFFSET = 11;

    /** Scale value for PDF size */
    scale = 1.2;

    /** Amount of pages that should be rendered past the pages in current viewport. */
    overscanCount = 1;

    containerDiv: HTMLElement | null = null;

    pageRefs: Map<number, RefObject<HTMLDivElement>> = new Map();

    selectionMap: Map<number, SelectionType[]> | undefined;

    _mounted: boolean = false;

    /**
     * Lifecycle function
     */

    componentDidMount = () => {
        this._mounted = true;
        this.computeSelectionMap();
        document.addEventListener("keydown", this.onKeyDown);
        document.addEventListener("selectstart", this.onTextSelectionStart);
        document.addEventListener("selectionchange", this.onTextSelectionChange);
        document.addEventListener("scroll", this.onScroll);

        // debug
        (window as any).PdfViewer = this;
    };

    componentDidUpdate = (prevProps: PdfViewerProps) => {
        if (this.props.selections !== prevProps.selections) this.computeSelectionMap();
        if (this.props.url !== prevProps.url) this.setState({ documentUuid: undefined });
    };

    componentWillUnmount = () => {
        this._mounted = false;
        document.removeEventListener("keydown", this.onKeyDown);
        document.removeEventListener("selectstart", this.onTextSelectionStart);
        document.removeEventListener("selectionchange", this.onTextSelectionChange);
        document.removeEventListener("scroll", this.onScroll);
    };

    /**
     * Helpers
     */

    resetSelections = () => {
        this.clearTextSelection();
        this.clearAreaSelection();
    };

    computeSelectionMap = () => {
        if (!this.props.selections) {
            this.selectionMap = undefined;
            return;
        }
        const selectionMap: Map<number, SelectionType[]> = new Map();
        this.props.selections.forEach((selection) => {
            selectionMap.set(selection.position.pageNumber, [
                ...(selectionMap.get(selection.position.pageNumber) ?? []),
                selection,
            ]);
        });
        this.selectionMap = selectionMap;
    };

    computePageDimensions = (pdf: pdfjs.PDFDocumentProxy) => {
        const promises = Array.from({ length: pdf.numPages })
            .map((x, i) => i + 1)
            .map((pageNumber) => {
                return new Promise<pdfjs.PDFPageProxy>((resolve, reject) => {
                    pdf.getPage(pageNumber).then(resolve, reject);
                });
            });

        Promise.all(promises).then((pages) => {
            if (!this._mounted) return;
            const pageDimensions = new Map<number, { width: number; height: number }>();
            const pageYOffsets: number[] = new Array(pdf.numPages);

            for (const page of pages) {
                const width = page.view[2] * this.scale;
                const height = page.view[3] * this.scale;
                pageDimensions.set(page.pageNumber, { width, height });
                pageYOffsets[page.pageNumber - 1] = (pageYOffsets[page.pageNumber - 2] ?? 0) + height + this.BORDER_WIDTH_OFFSET;
            }

            const visiblePages = this.getVisiblePages(document.documentElement, pageYOffsets);

            this.setState({ pageDimensions, pageYOffsets, visiblePages });
        });
    };

    getVisiblePages = (scrollElement: HTMLElement, pageYOffsets?: number[]) => {
        const pageOffsets = pageYOffsets ?? this.state.pageYOffsets;
        if (!pageOffsets) return [];
        const { scrollTop, clientHeight } = scrollElement;
        const firstVisiblePageIdx = pageOffsets.findIndex((offset) => offset > scrollTop);
        const lastVisiblePageIds = scrollTop + clientHeight > pageOffsets[pageOffsets.length - 1]
            ? pageOffsets.length - 1
            : pageOffsets.findIndex((offset) => offset > scrollTop + clientHeight);
        const underScanPages = Array.from(
            {length: Math.min(this.overscanCount, firstVisiblePageIdx - this.overscanCount + 1)}
            ).map((_, i) => i + firstVisiblePageIdx - this.overscanCount);
        const overScanPages = Array.from(
            {length: Math.min(this.overscanCount, this.state.numPages - lastVisiblePageIds - 1)}
            ).map((_, i) => i + lastVisiblePageIds + 1);
        const visibleCount = lastVisiblePageIds - firstVisiblePageIdx + 1;
        const visiblePages = Array.from({length: visibleCount}).map((x, i) => i + firstVisiblePageIdx);
        return [...underScanPages, ...visiblePages, ...overScanPages];
    };

    getItemKey = (index: number) => {
        return `doc_${this.state.documentUuid}_page_${index}`;
    };

    getPageRef = (pageNumber: number) => {
        let ref = this.pageRefs.get(pageNumber);
        if (!ref) {
            ref = createRef<HTMLDivElement>();
            this.pageRefs.set(pageNumber, ref);
        }
        return ref;
    };

    /**
     * Text selection handlers
     */

    clearTextSelection = () => {
        getWindow(this.containerDiv).getSelection()?.removeAllRanges();
        this.props.onTextSelection?.();
    };

    onTextSelectionStart = () => {
        this.clearAreaSelection();
    };

    onTextSelectionChange = () => {
        const selection = getWindow(this.containerDiv).getSelection();
        if (!selection || selection.isCollapsed) return;

        const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
        if (!range) return;

        const page = getPageFromRange(range);
        if (!page) return;
        const pageDimension = { width: page.node.clientWidth, height: page.node.clientHeight };

        const rects = getClientRects(range, page.node);
        if (rects.length === 0) return;

        const boundingRect = getBoundingRect(rects);
        const position = normalizePosition({ boundingRect, rects, pageNumber: page.number }, pageDimension);
        const text = Array.from(range.cloneContents().childNodes)
            .map((node) => node.textContent)
            .join(" ");

        this.props.onTextSelection?.({ position, text });
    };

    /**
     * Area selection handlers
     */

    clearAreaSelection = () => {
        this.setState({ areaSelectionActivePage: undefined, textSelectionEnabled: true });
        this.props.onAreaSelection?.();
    };

    onAreaSelectionStart = (pageNumber: number) => {
        this.clearTextSelection();
        this.setState({ textSelectionEnabled: false, areaSelectionActivePage: pageNumber });
    };

    onAreaSelectionEnd = (selection: NormalizedAreaSelection) => {
        this.setState({ textSelectionEnabled: true });
        this.props.onAreaSelection?.(selection);
    };

    /**
     * Event handlers
     */

    onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") this.resetSelections();
    };

    onMouseDown = () => {
        this.resetSelections();
    };

    onScroll = (event: Event) => {
        if (!this.containerDiv || !this.state.pageYOffsets) return;
        const scrollElement = (event.target as HTMLDocument | undefined)?.scrollingElement;
        if (!scrollElement) return;
        const visiblePages = this.getVisiblePages(scrollElement as HTMLElement);
        this.setState({ visiblePages });
    };

    onDocumentLoad = (pdf: pdfjs.PDFDocumentProxy) => {
        this.computePageDimensions(pdf);
        this.setState({ numPages: pdf.numPages, documentUuid: generateUuid() });
    };

    renderPages = () => {
        return Array.from(new Array(this.state.numPages), (el, i) => {
            const pageNumber = i + 1;
            if (!this.state.visiblePages || !this.state.visiblePages.includes(i))
                return <PlaceholderPage key={this.getItemKey(i)} pageDimensions={this.state.pageDimensions?.get(pageNumber)} />;
            const props = {
                style: {},
                pageNumber,
                innerRef: this.getPageRef(pageNumber),
                areaSelectionActive: this.state.areaSelectionActivePage === pageNumber,
                pageDimensions: this.state.pageDimensions?.get(pageNumber),
                selections: this.selectionMap?.get(pageNumber),
                enableAreaSelection: this.props.enableAreaSelection,
                onAreaSelectionStart: this.onAreaSelectionStart,
                onAreaSelectionEnd: this.onAreaSelectionEnd,
                areaSelectionComponent: this.props.areaSelectionComponent,
                textSelectionComponent: this.props.textSelectionComponent,
                newAreaSelectionComponent: this.props.newAreaSelectionComponent,
            };
            return <PdfPage key={this.getItemKey(i)} {...props} />;
        });
    };

    render = () => (
        <div
            ref={(ref) => (this.containerDiv = ref)}
            style={{
                position: "relative",
            }}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={this.onMouseDown}
        >
            <style>
                {`
                    .react-pdf__Page__textContent span::selection {
                        background-color: ${this.props.textSelectionColor ?? "blue"};
                `}
            </style>
            <Document
                className={this.state.textSelectionEnabled ? "" : "no-select"}
                file={this.props.url}
                onLoadSuccess={this.onDocumentLoad}
            >
                {this.containerDiv && this.state.documentUuid && this.state.pageDimensions && this.renderPages()}
            </Document>
            {this.props.children}
        </div>
    );
}