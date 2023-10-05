import WebViewerContext from '../contexts/webviewer-context';
import { useEffect, useRef, useContext, useState } from 'react';
import WebViewer, { Core } from '@pdftron/webviewer';
import { useAuthService } from "../contexts/auth-context";
import DefaultRedactSearchPatterns from './default-redact-search-patterns';
import { generateMarksReport, generateReport } from "../services/ReportGenerator";
import { generatePatientReport } from "../services/PatientReportGenerator";
import { generateSearchResultsReport } from "../services/SearchResultsReportGenerator";
import { getApiPatternsBySetId } from "../services/patternSets";
import { Pattern } from "../models/Pattern";
import { getPatternsForDocViewer } from "../pages/user/single-pattern";
import { useCustomModal } from "../pages/modals/custom-message-modal";
import MatchCategoryModal from "../pages/modals/match-category-modal";
import SmartFilterManager from "../tools/smart-filter-manager";
import { saveProjectFile, uploadFiles, uploadLogs, uploadProjectFile } from "./file-management";
import { useAppDispatch, useAppSelector } from "../hooks/redux-hook";
import { markStylesTypes } from '../constants';
import { filesSelector, loadFiles } from '../redux/file-management';
import { FileState } from '../models/FileState';
import { getApiFilesByProjectId, ocrPDFFIle, putApiFileOpenStatusById } from "../services/files";
import { showSnackbar } from "../redux/snackbar";
import { hideProgressLine, showProgressLine } from "../redux/progress-line";
import SanitizeModal from '../pages/modals/sanitize-modal';
import SanitizeRemovalModal from '../pages/modals/sanitize-removal-modal';
import { sanitizePDFFIle } from '../services/files';
import { getApiUsersById } from '../services/user';
import * as Sentry from "@sentry/react";
import ChangeStatusModal from '../pages/modals/change-status-modal';
import { putApiTasksStatusById } from '../services/task';


export default function WebViewerComponent(p: { files: any[], patternSetID?: number, projectID?: number, taskId?: number, initialTaskStatus?: string }) {
    // useContext returns whatever "value"
    // is provided by our provider we set up above

    const { setInstance } = useContext(WebViewerContext);
    const taskStatus = useRef(p.initialTaskStatus);
    const auth = useAuthService();
    const dispatch = useAppDispatch();
    let clickedApplyFlag = false
    const { loaded, projects } = useAppSelector(state => state.projects)
    const { showModal } = useCustomModal();
    const { loginInfo } = useAuthService();
    const viewer = useRef(null);
    const projectFiles: FileState[] = useAppSelector(filesSelector);
    const openTabRef = useRef<any>(null);
    const scannedDocList = useRef<Array<string>>([]);

    const loadFilesIntoStore = () => {
        getApiFilesByProjectId(p.projectID!)
            .then((files) => {
                dispatch(loadFiles(files));
            }).catch(() => {
                dispatch(showSnackbar({ message: "Error loading files!", type: "error" }));
            });
    }

    const markDocAsClosed = async (docName: string) => {
        const file = projectFiles.find(file => file.name === docName)
        if (file) {
            await putApiFileOpenStatusById(file.id, { isDocOpen: false });
        } else {
            // If we save file as copy in the webviewer, a new file is created, and the original file is closed.
            // This does cause the redux store to be updated with the new file, but since the webviewer component
            // itself does not refresh, projectFiles, which is derived from the redux state, is not yet
            // updated with the new file. So, when we go to close the new file, it will not be found in projectFiles,
            // so we make an api call here to find its id in the db so we can mark its isDocOpen field as false upon closing it
            // in webviewer
            const storedFiles = await getApiFilesByProjectId(p.projectID!);
            const savedCopyFile = storedFiles.find(file => file.name === docName);
            if (savedCopyFile) {
                await putApiFileOpenStatusById(savedCopyFile.id, { isDocOpen: false });
            }
        }
    }

    window.addEventListener('beforeunload', function (e) {
        for (const tab of openTabRef.current) {
            markDocAsClosed(tab.options.filename);
        }
    });

    useEffect(() => {
        return () => {
            for (const tab of openTabRef.current) {
                markDocAsClosed(tab.options.filename);
            }
        }
    }, []);

    const [sanitizationInProgress, setSanitizationInProgress] = useState(false);

    const base64ToBlob = (base64: any, type = "application/octet-stream") => {
        const binStr = atob(base64);
        const len = binStr.length;
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            arr[i] = binStr.charCodeAt(i);
        }
        return new Blob([arr], { type: type });
    }

    useEffect(() => {
        console.log("Files loaded in the viewer", p.files);
        // @ts-ignore
        WebViewer({
            licenseKey: 'key',
            path: '/webviewer/lib',
            fullAPI: true,
            isAdminUser: true,
            enableRedaction: true,
            annotationUser: loginInfo?.tenant?.user?.name,
            loadAsPDF: true,
            css: '/webviewer/lib/style-overrides.css', // Use this to override webviewer styles
            initialDoc: p.files,
            webviewerServerURL: 'url here'
        },
            viewer.current!,
        ).then(async (instance) => {
            //Helper Methods
            let pageTextCache = new Map<number, string>()
            async function getPageText(pageNum: number): Promise<string> {
                let pageText = pageTextCache.get(pageNum)
                if (pageText === undefined) {
                    pageText = await documentViewer.getDocument().getTextByPageAndRect(pageNum, new instance.Core.Math.Rect(0, 0, 1000, 1000))
                    pageText = pageText.replace(/\n/g, " ")
                    pageTextCache.set(pageNum, pageText)
                }
                return pageText
            }

            // All redaction ui related info can be found: https://www.pdftron.com/documentation/web/guides/redaction/
            setInstance(instance);
            const { documentViewer, Tools, PDFNet, Annotations, annotationManager } = instance.Core;
            await PDFNet.initialize();
            instance.UI.setToolbarGroup('toolbarGroup-Redact');
            instance.UI.setToolMode(Tools.ToolNames.REDACTION);
            instance.UI.openElements(['redactionPanel']);
            instance.UI.enableFeatures(['ContentEdit', instance.UI.Feature.MultiTab]);
            instance.UI.enableFadePageNavigationComponent();

            openTabRef.current = instance.UI.TabManager.getAllTabs();

            let searchTermOnLoad: string | undefined = undefined
            let searchOptionsOnLoad: any | undefined = undefined
            let searchAcrossDocuments: boolean = false

            documentViewer.addEventListener('documentLoaded', () => {
                // @ts-ignore
                instance.UI.initializeBackButton({ title: documentViewer.getDocument().getFilename(), projectName: activeProject?.name })
                instance.UI.setToolbarGroup('toolbarGroup-Redact');
                instance.UI.setToolMode(Tools.ToolNames.REDACTION);
                instance.UI.openElements(['redactionPanel']);
                //If the user wants to search across all documents, do a search for the same term whenever a new document
                //is opened. If they also want to deduplicate search results, then we need to wait until the annotations
                //are loaded, which is handled below.
                if (!deduplicateSearchResultsToggle) {
                    searchOnLoad();
                }
            })

            documentViewer.addEventListener('annotationsLoaded', () => {
                if (deduplicateSearchResultsToggle) {
                    searchOnLoad();
                }
            })

            instance.UI.addEventListener(instance.UI.Events.TAB_DELETED, e => {
                markDocAsClosed(e.detail.options.filename);
                openTabRef.current = instance.UI.TabManager.getAllTabs();
            });

            function searchOnLoad() {
                pageTextCache = new Map<number, string>()
                if (searchTermOnLoad && searchOptionsOnLoad && searchAcrossDocuments) {
                    instance.UI.searchTextFull(searchTermOnLoad, searchOptionsOnLoad);
                }
            }
            const sanitize = async () => {
                showModal(SanitizeModal, {
                    onRemoveAll: () => {
                        commitSanization();
                    },
                    onRemoveSelected: async () => {
                        const input = await commitSanization(['metadata', 'bookmarks', 'comments', 'files', 'forms', 'hiddenText', 'hiddenLayers', 'deletedContent', 'linkActions', 'overlappingObjects'], true)
                        showModal(SanitizeRemovalModal, {
                            scanData: input,
                            onSelection: (data: Array<any>) => {
                                commitSanization(data);
                            }
                        })
                    }
                })
            }

            const ocrDocument = async () => {
                const controller = new AbortController();
                const form = new FormData();
                const buffer = await instance.Core.documentViewer.getDocument().getFileData({ includeAnnotations: true, flags: PDFNet.SDFDoc.SaveOptions.e_linearized });
                const arr = new Uint8Array(buffer);
                const blob = new Blob([arr], { type: 'application/pdf' });
                form.append('file', blob)
                form.append('type', 'application/pdf')
                try {
                    // check if file is already scanned
                    const actualFileName = documentViewer.getDocument().getFilename();
                    if(actualFileName && scannedDocList.current.findIndex(val => val === actualFileName) !== -1) {
                        dispatch(showSnackbar({ message: 'File is already scanned by OCR!', type: "error" }));
                        return
                    }
                    setSanitizationInProgress(true);
                    const response: any = await ocrPDFFIle(form, controller.signal)
                    const blobed = base64ToBlob(response, 'application/pdf');
                    const scannedFileName = `${actualFileName.replace('.pdf', '')}-scanned.pdf`
                    instance.UI.loadDocument(blobed, {filename: scannedFileName})
                    scannedDocList.current = [...scannedDocList.current, scannedFileName]
                    setSanitizationInProgress(false);
                    dispatch(showSnackbar({ message: "File OCR scan completed", type: "info" }));
                } catch (e: any) {
                    setSanitizationInProgress(false);
                    dispatch(showSnackbar({ message: e.message, type: "error" }));
                    Sentry.captureException(e);
                    setSanitizationInProgress(false);
                }
            }

            const commitSanization = async (type = ['metadata', 'bookmarks', 'comments', 'files', 'forms', 'hiddenText', 'hiddenLayers', 'deletedContent', 'linkActions', 'overlappingObjects'], scan = false) => {
                const scanData = {
                    'metadata': 0, 'bookmarks': 0, 'comments': 0, 'files': 0, 'forms': 0, 'hiddenText': 0, 'hiddenLayers': 0, 'deletedContent': 0, 'linkActions': 0, 'overlappingObjects': 0
                }
                if (!scan) {
                    setSanitizationInProgress(true);
                }
                const forms = annotationManager.getFieldManager().getFields();
                if (type.indexOf('forms') !== -1) {
                    // scanData['forms'] = forms.length;
                    forms.forEach((annotation) => {
                        annotation.widgets?.forEach((val: any) => {
                            if (val instanceof Annotations.WidgetAnnotation || (val instanceof Annotations.ButtonWidgetAnnotation) || (val instanceof Annotations.CheckButtonWidgetAnnotation) || (val instanceof Annotations.ChoiceWidgetAnnotation) || (val instanceof Annotations.TextWidgetAnnotation)) {
                                if (!scan) {
                                    annotationManager.deleteAnnotation(val)
                                }
                                scanData['forms'] = ++scanData['forms'];
                            }
                        })
                    })
                }
                let linkCounter = 0;
                const list = annotationManager.getAnnotationsList();
                for (let i = 0; i < list.length; i++) {
                    // console.log(i, list[)
                    const keys: string[] = Object.keys(Annotations);
                    keys.filter(val => val.length > 2 && val !== 'Annotation').forEach((val: string) => {
                        try {
                            // @ts-ignore
                            if (list[i] instanceof Annotations[val]) {
                                console.log(val, i)
                            }
                        }
                        catch (e) {
                            console.log(e)
                        }
                    })
                    if (type.indexOf('files') !== -1 && (list[i] instanceof Annotations.FileAttachmentAnnotation || list[i] instanceof Annotations.FileAttachmentUtils)) {
                        if (!scan) {
                            annotationManager.deleteAnnotation(list[i]);
                            i = i - 1
                            continue;
                        } else {
                            scanData['files'] = ++scanData['files'];
                        }
                    }
                    if (type.indexOf('comments') !== -1 && (list[i] instanceof Annotations.MarkupAnnotation)) {
                        console.log(list[i])
                        if (!scan) {
                            annotationManager.deleteAnnotation(list[i])
                            i = i - 1
                            continue;
                        } else {
                            scanData['comments'] = ++scanData['comments'];
                        }
                    }
                    if (type.indexOf('linkActions') !== -1 && (list[i] instanceof Annotations.Link)) {
                        if (!scan) {
                            console.log('deleted', ++linkCounter, list.length)
                            annotationManager.deleteAnnotation(list[i])
                            i = i - 1
                            continue;
                        } else {
                            scanData['linkActions'] = ++scanData['linkActions'];
                        }
                    }
                }
                const backendSanitizationParams = {
                    removeBookmarks: type.indexOf('bookmarks') !== -1,
                    removeMeta: type.indexOf('metadata') !== -1
                }
                const buffer = await instance.Core.documentViewer.getDocument().getFileData();
                const doc = await PDFNet.PDFDoc.createFromBuffer(buffer);
                if (type.indexOf('bookmarks') !== -1) {

                    if (scan) {
                        let firstBookmark = await doc.getFirstBookmark();
                        const scanPromise = new Promise(async (resolve, reject) => {
                            while (firstBookmark && firstBookmark.isValid()) {
                                const next = await firstBookmark.getNext();
                                if (!scan) {
                                    await firstBookmark.delete()
                                } else {
                                    scanData['bookmarks'] = ++scanData['bookmarks'];
                                }
                                firstBookmark = next;
                            }
                            resolve(true);
                        })
                        await scanPromise;
                    }
                }

                if (type.indexOf('metadata') !== -1) {

                    if (scan) {
                        const docInfo = await doc.getDocInfo();
                        const infoData = [];
                        infoData.push(await docInfo.getProducer())
                        infoData.push(await docInfo.getAuthor())
                        infoData.push(await docInfo.getTitle())
                        infoData.push(await docInfo.getAuthor())
                        infoData.push(await docInfo.getCreator())
                        infoData.push(await docInfo.getKeywords())
                        infoData.push(await docInfo.getSubject())
                        let counter = 0;
                        infoData.forEach((val) => {
                            if (val) {
                                ++counter;
                            }
                        })
                        scanData['metadata'] = counter;
                        return scanData;
                    }
                }

                // sanitization in backend
                if (!scan && (backendSanitizationParams.removeBookmarks || backendSanitizationParams.removeMeta)) {
                    const controller = new AbortController();
                    const form = new FormData();
                    const buffer = await instance.Core.documentViewer.getDocument().getFileData({ includeAnnotations: true, flags: PDFNet.SDFDoc.SaveOptions.e_linearized });
                    const arr = new Uint8Array(buffer);
                    const blob = new Blob([arr], { type: 'application/pdf' });
                    // initialize all the annotations again, for now put into settimeout as loading document is an async process
                    form.append('file', blob)
                    form.append('removeBookmarks', JSON.stringify(backendSanitizationParams.removeBookmarks))
                    form.append('removeMeta', JSON.stringify(backendSanitizationParams.removeMeta))
                    try {
                        //This is a string that represents the file.
                        const parsedFile: any = await sanitizePDFFIle(form, controller.signal)
                        const blobed = base64ToBlob(parsedFile, 'application/pdf');
                        console.log('loaded sanitized file')
                        instance.UI.loadDocument(blobed)
                        setTimeout(() => {
                            // @ts-ignore
                            annotationManager.addAnnotations([...(type.indexOf('forms') === -1 ? forms : []), ...list.filter(val => {
                                // read all the annotations
                                return (!(val instanceof Annotations.WidgetAnnotation) && !(val instanceof Annotations.ButtonWidgetAnnotation) && !(val instanceof Annotations.CheckButtonWidgetAnnotation) && !(val instanceof Annotations.ChoiceWidgetAnnotation) && !(val instanceof Annotations.TextWidgetAnnotation))
                            })])
                            setSanitizationInProgress(false);
                            // I've put a wait time of 8s, so pdf gets loaded and annotations gets applied again.
                        }, 8000)
                    } catch (e) {
                        console.log(e)
                        Sentry.captureException(e);
                        setSanitizationInProgress(false);
                    }

                }
                if (!scan && (!backendSanitizationParams.removeBookmarks && !backendSanitizationParams.removeMeta)) {
                    setSanitizationInProgress(false);
                }
            }

            function searchListener(searchValue: any, options: any, results: any) {
                searchTermOnLoad = searchValue
                searchOptionsOnLoad = options
            }
            instance.UI.addSearchListener(searchListener);

            const activeProject = projects.find((val) => val.id === p.projectID);
            if (activeProject) {
                const markStyleId = markStylesTypes.find((val) => val.name === activeProject.markStyleName)?.id;
                if (markStyleId) {
                    // @ts-ignore
                    instance.UI.initializeRedaction(markStyleId);
                } else {
                    console.log("Couldn't find a valid mark style for this project. We'll choose CTIS as the default")
                    // @ts-ignore
                    instance.UI.initializeRedaction(1);
                }
            } else {
                // @ts-ignore
                instance.UI.initializeRedaction(1);
            }

            let deduplicateSearchResultsToggle = false;
            let logs: log[] = []

            function isQuadFullyCovered(quad: any, annotationsOnPage: any[]): boolean {
                // (x1,y1) is the upper left corner and (x3,y3) is the bottom right
                const points: { x1: number, y1: number, x3: number, y3: number } = quad.getPoints()
                const searchRect = { x1: points.x1, y1: points.y1, x2: points.x3, y2: points.y3 } as Rectangle
                for (let annot of annotationsOnPage) {
                    for (let quad of annot.Quads) {
                        const annotRect = { x1: quad.x1, y1: quad.y1, x2: quad.x3, y2: quad.y3 } as Rectangle
                        if (contains(annotRect, searchRect)) {
                            return true
                        }
                    }
                }
                return false
            }

            const replaceAnnotationsInPlace = async (annotations: any[], replacementText: string) => {
                const doc = await documentViewer.getDocument().getPDFDoc();
                // Create a map where each key is a page number, and each value is a list of annotations on that page
                const annotationsByPage: Map<number, any[]> = annotations.reduce((map: Map<number, any[]>, annotation: any) => {
                    const pageNumber = annotation.getPageNumber();
                    return map.set(pageNumber, (map.get(pageNumber) || []).concat(annotation));
                }, new Map<number, any[]>());


                await annotationsByPage.forEach(async (annotations: any[], pageNumber: number) => {
                    // Run PDFNet methods with memory management
                    await PDFNet.runWithCleanup(async () => {
                        // lock the document before a write operation
                        // runWithCleanup will auto unlock when complete
                        await doc.lock();
                        const replacer = await PDFNet.ContentReplacer.create();
                        const page = await doc.getPage(pageNumber);

                        for (let i = 0; i < annotationsByPage.get(pageNumber)!.length; i++) {
                            const annotation = annotationsByPage.get(pageNumber)![i]
                            const firstRect = annotation.getRect()
                            const height = annotation.getHeight()
                            const firstPoint = documentViewer.getDocument().getPDFCoordinates(1, firstRect.x1, firstRect.y1)
                            const secondPoint = documentViewer.getDocument().getPDFCoordinates(1, firstRect.x2, firstRect.y2)
                            //Make the rectangle a little shorter so that it doesn't delete text on the lines above and below it.
                            const rect = new PDFNet.Rect(firstPoint.x, secondPoint.y + (height * 0.1), secondPoint.x, firstPoint.y - (height * 0.1))
                            //This deletes all the text in the rectangle and adds the replacement text.
                            await replacer.addText(rect, replacementText);
                        }
                        await replacer.process(page);
                    }, 'key here');
                })
                // clear the cache (rendered) data with the newly updated document
                documentViewer.refreshAll();
                // Update viewer to render with the new document
                documentViewer.updateView();
                // Refresh searchable and selectable text data with the new document
                documentViewer.getDocument().refreshTextData();

                const highlights = getHighlightsOverAnnotations(annotations)
                annotationManager.deleteAnnotations(annotations)
                annotationManager.addAnnotations(highlights)
            }

            const getHighlightsOverAnnotations = (annotations: any[]) => {
                let highlights = []
                for (const annotation of annotations) {
                    const highlight = new Annotations.TextHighlightAnnotation({
                        PageNumber: annotation.getPageNumber(),
                        Quads: [annotation.Quads],
                    });
                    highlight.PageNumber = annotation.PageNumber;
                    highlight.Color = new Annotations.Color(144, 238, 144, 1.0)
                    highlight.Opacity = 1.0;
                    highlight.Quads = annotation.Quads;
                    highlight.setContents(annotation.getCustomData('trn-annot-preview'));
                    highlight.Author = loginInfo?.tenant?.user?.name || 'Unknown';
                    highlights.push(highlight)
                }
                return highlights
            }

            //This doesn't work yet. I will work on it more in a future story
            const reflow = async () => {
                const doc = await documentViewer.getDocument().getPDFDoc();
                await PDFNet.runWithCleanup(async () => {
                    await doc.lock();
                    const replacer = await PDFNet.ContentReplacer.create();
                    const page = await doc.getPage(1);
                    await replacer.setMatchStrings(' ', ' ')
                    await replacer.addString('General Weakness', 'AE');
                    //There's an error here
                    await replacer.process(page)
                }, 'key here');

                // clear the cache (rendered) data with the newly updated document
                documentViewer.refreshAll();
                // Update viewer to render with the new document
                documentViewer.updateView();
                // Refresh searchable and selectable text data with the new document
                documentViewer.getDocument().refreshTextData();
            }

            const reflowButton = {
                type: 'actionButton',
                img: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="#ff0000"><path d="M0 0h24v24H0z" fill="none"/><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
                onClick: async () => {
                    await reflow()
                },
                dataElement: 'alertButton',
                hidden: ['mobile']
            };

            const deduplicateButton = {
                type: 'statefulButton',
                initialState: 'Dupes',
                states: {
                    Dupes: {
                        img: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="#000000"><path d="M0 0h24v24H0z" fill="none"/><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
                        onClick: (update: (newState: any) => void) => {
                            deduplicateSearchResultsToggle = true
                            console.log(`deduplicate search results? ${deduplicateSearchResultsToggle}`)
                            update('NoDupes');
                        },
                        title: "Show all search results"
                    },
                    NoDupes: {
                        img: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="#000000"><g><rect x="0" y="0" width="24" height="24" rx="5" fill="#111122"/></g><path d="M0 0h24v24H0z" fill="none"/><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
                        onClick: (update: (newState: any) => void) => {
                            deduplicateSearchResultsToggle = false
                            console.log(`deduplicate search results? ${deduplicateSearchResultsToggle}`)
                            update('Dupes');
                        },
                        title: "Don't show search results in existing annotations"
                    }
                },
                dataElement: 'deduplicateButton'
            };


            // this is an example of how to add a 5th tool
            const redactionTool5 = new Tools.RedactionCreateTool(documentViewer);
            // Customize the look/feel
            // Example of valid properties: StrokeColor, TextColor, FillColor, FontSize, Opacity, StrokeThickness, Precision, Scale, OverlayText, Style and Dashes.
            redactionTool5.setStyles({
                OverlayText: 'PPD'
            });
            // Register it with the viewer
            instance.UI.registerTool({
                toolName: 'AnnotationCreateRedaction5',
                toolObject: redactionTool5,
                buttonImage: 'icon-tool-select-area-redaction',
                buttonName: 'redactionButton5',
            })

            // Link the tool to a button
            const redactionToolButton5 = {
                type: 'toolButton',
                toolName: 'AnnotationCreateRedaction5',
            }

            let replacementTextInput = document.createElement('input');
            replacementTextInput.type = 'text';
            replacementTextInput.id = 'unique_id_1';
            // @ts-ignore
            replacementTextInput.style.width = '500px';

            const replacementTextModalOptions = {
                dataElement: 'ReplacementTextModal',
                header: {
                    title: 'Enter Replacement Text',
                    className: 'ReplacementTextModal-header',
                },
                body: {
                    className: 'ReplacementTextModal-body',
                    children: [replacementTextInput]
                },
                footer: {
                    className: 'myCustomModal-footer footer',
                    children: [
                        {
                            title: 'Cancel',
                            button: true,
                            style: {},
                            className: 'modal-button cancel-form-field-button',
                            onClick: () => { instance.UI.closeElements([replacementTextModalOptions.dataElement]) }
                        },
                        {
                            title: 'Replace',
                            button: true,
                            style: {},
                            className: 'modal-button confirm ok-btn',
                            onClick: () => {
                                instance.UI.closeElements([replacementTextModalOptions.dataElement]);
                                //@ts-ignore
                                replaceAnnotationsInPlace(annotationManager.getAnnotationsList().filter(redaction => redaction.markChecked), replacementTextInput.value)
                            }
                        },
                    ]
                }
            }

            //@ts-ignore
            instance.UI.addCustomModal(replacementTextModalOptions);


            //#region Saving
            // Elements for the Save Copy modal
            let saveAsFileInput = document.createElement('input');
            saveAsFileInput.type = 'text';
            saveAsFileInput.id = 'unique_id_1';
            // @ts-ignore
            saveAsFileInput.style.width = '500px';
            let saveAsFileLabel = document.createElement('label');
            saveAsFileLabel.innerText = 'File Name:  ';
            saveAsFileLabel.setAttribute('for', 'unique_id_1');

            // Save copy modal parameters
            const saveAsModalOptions = {
                dataElement: 'SaveAsModal',
                header: {
                    title: 'Save Copy',
                    className: 'myCustomModal-header',
                },
                body: {
                    className: 'myCustomModal-body',
                    children: [saveAsFileLabel, saveAsFileInput],
                },
                footer: {
                    className: 'myCustomModal-footer footer',
                    children: [
                        {
                            title: 'Cancel',
                            button: true,
                            style: {},
                            className: 'modal-button cancel-form-field-button',
                            onClick: () => { instance.UI.closeElements([saveAsModalOptions.dataElement]) }
                        },
                        {
                            title: 'Save',
                            button: true,
                            style: {},
                            className: 'modal-button confirm ok-btn',
                            onClick: () => {
                                instance.UI.closeElements([saveAsModalOptions.dataElement]);
                                saveAsNewFile(saveAsFileInput.value);
                            }
                        },
                    ]
                }
            }

            //We need ts-ignore because typescript expects us to provide a render function. That's an option for this
            //method, but we want to not provide one so that it uses the default.
            //@ts-ignore
            instance.UI.addCustomModal(saveAsModalOptions);


            const saveFileInPlace = async () => {
                await saveFile(documentViewer.getDocument().getFilename(), true)
            }

            //Opens a modal to ask the user where they want to save a copy of this file. The saving is called from
            //the modal itself.
            const promptSaveAsNewFile = () => {
                const incrementedFileName: string = incrementFileName(documentViewer.getDocument().getFilename())
                saveAsFileInput.value = incrementedFileName
                instance.UI.openElements([saveAsModalOptions.dataElement])
            }

            const saveAsNewFile = async (fileName: string) => {
                const currentFile = documentViewer.getDocument().getFilename()
                const currentFileId = projectFiles.find(file => file.name === currentFile)?.id
                if (currentFileId) {
                    await putApiFileOpenStatusById(currentFileId, { isDocOpen: false })
                    loadFilesIntoStore();
                } else {
                    throw Error("Could not find file ID for current file")
                }
                saveFile(fileName, false).then(saveLocation => {
                    if (saveLocation) {
                        instance.UI.loadDocument(saveLocation!, { filename: fileName })
                        //@ts-ignore
                        instance.UI.TabManager.setTabName(fileName)
                        openTabRef.current = instance.UI.TabManager.getAllTabs();
                    }
                }
                )
            }

            const saveFile = async (fileName: string, existingFileSave: boolean): Promise<string | undefined> => {
                dispatch(showProgressLine());
                const doc = documentViewer.getDocument();
                //This string contains all the information about annotations in the document.
                const xfdfString = await annotationManager.exportAnnotations({ fields: true });
                const data = await doc.getFileData({
                    // saves the document with annotations in it
                    xfdfString
                });
                const arr = new Uint8Array(data);
                const blob = new Blob([arr], { type: 'application/pdf' });

                const file = new File([blob], fileName)
                //We can be sure project ID is not null because we disable the save buttons when accessing the webviewer not from a project
                return saveProjectFile(file, p.projectID!).then(saveLocation => {
                    const currentDocumentLogs = logs.filter(log => log.document === fileName)
                    uploadLogsToS3(currentDocumentLogs, fileName.split('.')[0])//the .split removes the type
                    logs = logs.filter(log => log.document !== fileName)
                    dispatch(hideProgressLine());
                    dispatch(showSnackbar({ message: `Successfully saved ${fileName}`, type: "info" }));
                    return saveLocation;
                }).catch(reason => {
                    dispatch(showProgressLine());
                    console.log("failed to save file", reason)
                    dispatch(showSnackbar({ message: "Error Saving File!", type: "error" }));
                    return undefined;
                })
            }

            //Disable the standard save as button and add our own
            instance.UI.disableElements(["saveAsButton"]);
            if (p.projectID) {
                // instance.UI.settingsMenuOverlay.add([{
                //     type: 'actionButton',
                //     className: "row",
                //     img: 'icon-save',
                //     onClick: () => {
                //         instance.UI.closeElements(['menuOverlay']);
                //         promptSaveAsNewFile();
                //     },
                //     label: 'Save Copy'
                // }], "downloadButton"); //Put this after the download button

                //Add an item in the menu for saving
                // instance.UI.settingsMenuOverlay.add([{
                //     type: 'actionButton',
                //     className: "row",
                //     img: 'icon-save',
                //     onClick: () => {
                //         instance.UI.closeElements(['menuOverlay']);
                //         saveFileInPlace();
                //     },
                //     label: 'Save'
                // }], "downloadButton"); //Put this after the download button
            }

            // uncomment to implement autosave every 30 seconds.
            //setInterval(saveFile, 30000);
            //#endregion

            const searchAcrossDocsButton = {
                type: 'statefulButton',
                initialState: 'OneDoc',
                states: {
                    OneDoc: {
                        searchAcrossDocs: false,
                        img: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24px" fill="#000000"><g><path d="M0,0h24v24H0V0z" fill="none"/></g><g><path d="M7,9H2V7h5V9z M7,12H2v2h5V12z M20.59,19l-3.83-3.83C15.96,15.69,15.02,16,14,16c-2.76,0-5-2.24-5-5s2.24-5,5-5s5,2.24,5,5 c0,1.02-0.31,1.96-0.83,2.75L22,17.59L20.59,19z M17,11c0-1.65-1.35-3-3-3s-3,1.35-3,3s1.35,3,3,3S17,12.65,17,11z M2,19h10v-2H2 V19z"/></g></svg>',
                        onClick: (update: (newState: any) => void) => {
                            searchAcrossDocuments = true
                            console.log(`search across docs? ${searchAcrossDocuments}`)
                            update('AllDocs');
                        },
                        title: 'Searching only the current document'
                    },
                    AllDocs: {
                        searchAcrossDocs: true,
                        img: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24px"><g><rect x="0" y="0" width="24" height="24" rx="5" fill="#111122"/></g><g><path d="M7,9H2V7h5V9z M7,12H2v2h5V12z M20.59,19l-3.83-3.83C15.96,15.69,15.02,16,14,16c-2.76,0-5-2.24-5-5s2.24-5,5-5s5,2.24,5,5 c0,1.02-0.31,1.96-0.83,2.75L22,17.59L20.59,19z M17,11c0-1.65-1.35-3-3-3s-3,1.35-3,3s1.35,3,3,3S17,12.65,17,11z M2,19h10v-2H2 V19z"/></g></svg>',
                        onClick: (update: (newState: any) => void) => {
                            searchAcrossDocuments = false
                            console.log(`search across docs? ${searchAcrossDocuments}`)
                            update('OneDoc');
                        },
                        title: 'Searching all open documents'
                    }
                },
                dataElement: 'searchAcrossDocsButton'
            };

            const createReport = (event: any) => {
                const sortedAnnotations = annotationManager.getAnnotationsList().sort((a, b) => {
                    //sorting by location in document then location in page
                    if (a.getPageNumber() !== b.getPageNumber()) {
                        return a.getPageNumber() - b.getPageNumber()
                    } else if (a.getY() !== b.getY()) {
                        return a.getY() - b.getY()
                    } else {
                        return a.getX() - b.getX()
                    }
                }).filter(annotation => annotation.elementName !== 'link')

                if (event.target.value === "patientReport") {
                    const { headerRow, reportRowsArray } = generatePatientReport(sortedAnnotations, documentViewer.getDocument().getFilename())
                    localStorage.setItem("patientReportHeaderRow", JSON.stringify(headerRow));
                    localStorage.setItem("patientReportRows", JSON.stringify(reportRowsArray));
                    window.open('/app/user/docs/patientReport');
                } else if (event.target.value === "batchReport") {
                    const { headerRow, reportRowsArray } = generateReport(sortedAnnotations, documentViewer.getDocument().getFilename())
                    localStorage.setItem("batchReportHeaderRow", JSON.stringify(headerRow));
                    localStorage.setItem("batchReportRows", JSON.stringify(reportRowsArray));
                    window.open('/app/user/docs/batchReport');
                } else if (event.target.value === "marksReport") {
                    const { headerRow, reportRowsArray } = generateMarksReport(sortedAnnotations, documentViewer.getDocument().getFilename())
                    localStorage.setItem("marksReportHeaderRow", JSON.stringify(headerRow));
                    localStorage.setItem("marksReportRows", JSON.stringify(reportRowsArray));
                    window.open('/app/user/docs/marksReport');
                } else if (event.target.value === "searchReport") {
                    const { headerRow, reportRowsArray } = generateSearchResultsReport(documentViewer.getPageSearchResults(), documentViewer.getDocument().getFilename())
                    localStorage.setItem("searchReportHeaderRow", JSON.stringify(headerRow));
                    localStorage.setItem("searchReportRows", JSON.stringify(reportRowsArray));
                    window.open('/app/user/docs/searchReport');
                } else if (event.target.value === "logs") {
                    window.open('/app/user/docs/' + documentViewer.getDocument().getFilename().split('.')[0] + '/logsFile');
                }

            }

            const ReportsMenu = () => {
                return (
                    <select
                        placeholder={"Reports"} title={"Reports"}
                        onChange={createReport}
                        value={""}
                        defaultValue={""}
                    >
                        <option value="" disabled hidden={true}>Reports</option>
                        <option value="batchReport">Batch Report</option>
                        <option value="patientReport">Patient Report</option>
                        <option value="marksReport">Marks Report</option>
                        <option value="searchReport">Search Report</option>
                        <option value="logs">Logs</option>
                    </select>
                );
            }

            const reportsElement = {
                type: 'customElement',
                render: () => <ReportsMenu />
            };

            //#region text select search
            //Pre fill the hard coded patterns
            console.log(`pattern set id: ${p.patternSetID}`)

            const patterns: Pattern[] | undefined = p.patternSetID ? await getApiPatternsBySetId(p.patternSetID) : undefined
            const patternMap = new Map<string, Pattern>();
            patterns?.forEach((pattern) => {
                patternMap.set(pattern.name, pattern);
            });
            let redactSearchPatterns: { label: string, type: string, regex: RegExp }[] = patterns ? await getPatternsForDocViewer(patterns, auth.loginInfo?.tenant?.schema) : DefaultRedactSearchPatterns
            redactSearchPatterns.sort((a, b) => (a.type > b.type) ? 1 : -1);
            let lastCategory: string | undefined = undefined

            const prefillRedactSearchPatterns = () => {
                // Remove the defaults
                instance.UI.removeRedactionSearchPattern(instance.UI.RedactionSearchPatterns.EMAILS);
                instance.UI.removeRedactionSearchPattern(instance.UI.RedactionSearchPatterns.PHONE_NUMBERS);
                instance.UI.removeRedactionSearchPattern(instance.UI.RedactionSearchPatterns.CREDIT_CARDS);
                redactSearchPatterns.forEach(pattern => {
                    //If the regex is blank, then don't add it as a possible search term. It still gets added to the
                    //list of categories when manually setting the category of a mark.
                    if (pattern.regex) {
                        instance.UI.addRedactionSearchPattern(pattern);
                    }
                });
            };
            prefillRedactSearchPatterns();

            let smartFiltersToggle = false

            const smartFilterManager: SmartFilterManager = new SmartFilterManager(redactSearchPatterns)

            const smartFilterButton = {
                type: 'statefulButton',
                initialState: 'NoSmartFilters',
                states: {
                    NoSmartFilters: {
                        img: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="#000000"><path d="M0 0h24v24H0z" fill="none"/><path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>',
                        onClick: (update: (newState: any) => void) => {
                            smartFiltersToggle = true
                            console.log(`smart filters on? ${smartFiltersToggle}`)
                            update('SmartFilters');
                        },
                        title: "Smart Filters Off"
                    },
                    SmartFilters: {
                        img: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="#000000"><g><rect x="0" y="0" width="24" height="24" rx="5" fill="#111122"/></g><path d="M0 0h24v24H0z" fill="none"/><path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>',
                        onClick: (update: (newState: any) => void) => {
                            smartFiltersToggle = false
                            console.log(`smart filters on? ${smartFiltersToggle}`)
                            update('NoSmartFilters');
                        },
                        title: "Smart Filters On (remove likely false positives)"
                    }
                },
                dataElement: 'deduplicateButton'
            };

            documentViewer.addEventListener('notify', (notification: string) => { console.log(notification) })

            instance.UI.setHeaderItems(header => {
                header.push(reportsElement)
                header.push(searchAcrossDocsButton)
                header.push(deduplicateButton)
                header.push(smartFilterButton)
                //header.push(reflowButton)
                header.getHeader('toolbarGroup-Redact').get('toolsOverlay').insertAfter(redactionToolButton5);
            });

            //This lets the user double-click a word, click the search icon, and a search will be performed for all instances of that word.
            //The results get added as marks.
            const searchOptions = {
                type: 'actionButton',
                img: 'icon-header-search',
                onClick: async () => {
                    const results: any[] = [];
                    const mode = instance.Core.Search.Mode.REGEX | instance.Core.Search.Mode.WILD_CARD | instance.Core.Search.Mode.HIGHLIGHT;
                    const searchOptions = {
                        // If true, a search of the entire document will be performed. Otherwise, a single search will be performed.
                        fullSearch: true,
                        // The callback function that is called when the search returns a result.
                        onResult: (result: { resultCode: number; quads: { getPoints: () => any; }[]; pageNum: any; }) => {
                            if (result.resultCode === instance.Core.Search.ResultCode.FOUND) {
                                const textQuad = result.quads[0].getPoints();
                                if (textQuad !== undefined && result.pageNum !== undefined) {
                                    const annot = new Annotations.RedactionAnnotation({
                                        PageNumber: result.pageNum,
                                        Quads: [textQuad],
                                        StrokeColor: new Annotations.Color(255, 0, 0, 1),
                                    });
                                    annot.setContents(documentViewer.getSelectedText());
                                    annot.Author = loginInfo?.tenant?.user?.name || 'Unknown';
                                    //Not sure why there's a compile error here. It works fine when we ignore it.
                                    // @ts-ignore
                                    annot.type = "quick-search"
                                    results.push(annot);
                                    annotationManager.addAnnotation(annot);

                                }
                            }
                        }
                    };

                    documentViewer.textSearchInit(documentViewer.getSelectedText(), mode, searchOptions);
                    await annotationManager.drawAnnotationsFromList(results);
                },
                dataElement: 'highlightedTextSearch'
            }
            instance.UI.textPopup.add([searchOptions], 'textPopup');
            //#endregion

            //#region Annotation events

            function changeAnnotationColor(annotation: any, category: string) {
                if (patternMap.has(category)) {
                    const [red, green, blue] = convertHexStringToRgbArray(patternMap.get(category)!.color)
                    annotation.Color = new Annotations.Color(red, green, blue, 1.0)
                }
            }

            const afterPickingCategory = (annotation: any, category: string) => {
                // Send the category to the webviewer so that it knows to style the mark differently if it's CCI or CBI.
                // This needs to be done before changing the color, if it's done after then the styling changes overwrite
                // the color change.
                // @ts-ignore
                instance.UI.setSelectedCategory({ annotation: [annotation], value: category, trigger: Math.ceil(Math.random() * 100000) })
                annotation.type = category
                annotation.setCustomData('trn-redaction-type', category)
                changeAnnotationColor(annotation, category)
                //Select the annotation so that it redraws with the new category and color.
                annotationManager.selectAnnotation(annotation)
                lastCategory = category
            }
            annotationManager.addEventListener('changestatus', () => {
                if (p.taskId) {
                    showModal(ChangeStatusModal, {
                        initialTaskStatus: taskStatus.current as string,
                        onSelection: async (checked) => {
                            // update the status
                            try {
                                taskStatus.current = checked
                                dispatch(showProgressLine());
                                await putApiTasksStatusById(p.taskId as number, { status: checked as any })
                                dispatch(hideProgressLine());
                                dispatch(showSnackbar({ message: `Status successfully changed!`, type: "info" }));
                            }
                            catch (err) {
                                dispatch(hideProgressLine());
                                dispatch(showSnackbar({ message: `Error updating status`, type: "error" }));
                            }
                        }
                    })
                } else {
                    dispatch(showSnackbar({ message: `No task id linked with the opened document`, type: "error" }));
                }
            })
            //For changing the category of existing marks using the Change Category button.
            annotationManager.addEventListener('commitClick', ({ annotations }) => {
                if (annotations.length > 0) {
                    showModal(MatchCategoryModal, {
                        patterns: redactSearchPatterns,
                        lastPattern: lastCategory,
                        annotation: annotations,
                        afterModal: (annotations: any, category: string) => {
                            for (let annotation of annotations) {
                                afterPickingCategory(annotation, category)
                            }
                            // @ts-ignore
                            instance.UI.setSelectedCategory({ annotation: annotations, value: category, trigger: Math.ceil(Math.random() * 100000) })
                            lastCategory = category
                        }
                    })
                }
            })

            annotationManager.addEventListener('styleUpdate', ({ style }) => {
                dispatch(showSnackbar({ message: `Mark style changed to ${style}`, type: "info" }))
            })

            annotationManager.addEventListener('replaceText', () => {
                console.log('replacing text')
                instance.UI.openElements([replacementTextModalOptions.dataElement])
            })

            const iframeDoc = instance.UI.iframeWindow.document;
            //When the user applies a redaction. the event that gets triggered is that an annotation was deleted. However, we want the logs to say that the user applied redaction.
            // so we add a flag when the user clicks the button, so we can log the appropriate action
            const applyRedactionButton = iframeDoc.querySelector('[data-element="WarningModalSignButton"]')
            //@ts-ignore
            applyRedactionButton!.onclick = function () {
                clickedApplyFlag = true
            }

            annotationManager.addEventListener('sanitizedoc', sanitize)
            annotationManager.addEventListener('triggerOCR', ocrDocument)

            annotationManager.addEventListener('annotationChanged', (annotations: any[], action, { imported }) => {
                // If the event is triggered by importing then it can be ignored
                // This will happen when importing the initial annotations
                // from the server or individual changes from other users
                if (imported) return;

                let pages: number[] = annotations.map(annotation => annotation.getPageNumber())
                // Three different events available for autosaving/other after redact callbacks
                switch (action) {
                    case 'delete': {
                        if (clickedApplyFlag) {
                            logs.push({ date: getCurrentDate(), time: getCurrentTime(), document: documentViewer.getDocument().getFilename(), user: loginInfo?.tenant?.user?.name, roles: loginInfo?.tenant?.user?.roles, action: logAction.APPLY, annotationType: annotations[0].Subject, pages: pages })
                        } else {
                            logs.push({ date: getCurrentDate(), time: getCurrentTime(), document: documentViewer.getDocument().getFilename(), user: loginInfo?.tenant?.user?.name, roles: loginInfo?.tenant?.user?.roles, action: logAction.DELETE, annotationType: annotations[0].Subject, pages: pages })
                        }
                        clickedApplyFlag = false
                        //saveFile();
                        break;
                    }
                    case 'add': {
                        //When a user adds a redaction manually, ask them what the category is.
                        if (annotations.length === 1 && (!annotations[0].type || annotations[0].type === annotations[0].Author) && annotations[0].Subject === 'Redact') {
                            showModal(MatchCategoryModal, {
                                patterns: redactSearchPatterns,
                                lastPattern: lastCategory,
                                annotation: annotations[0],
                                afterModal: afterPickingCategory
                            })
                        }
                        //Set the color based on the category
                        annotations.filter(annotation => annotation.Subject === 'Redact').forEach(annotation => {
                            changeAnnotationColor(annotation, annotation.type)
                        })
                        logs.push({ date: getCurrentDate(), time: getCurrentTime(), document: documentViewer.getDocument().getFilename(), user: loginInfo?.tenant?.user?.name, roles: loginInfo?.tenant?.user?.roles, action: logAction.ADD, annotationType: annotations[0].Subject, pages: pages })
                        //saveFile();
                        break;
                    }
                    case 'modify': {
                        //TODO: when we enable the edit text feature. I think this is the event that gets called when you edit. We need to then log that the document was edited
                        logs.push({ date: getCurrentDate(), time: getCurrentTime(), document: documentViewer.getDocument().getFilename(), user: loginInfo?.tenant?.user?.name, roles: loginInfo?.tenant?.user?.roles, action: logAction.MODIFY, annotationType: annotations[0].Subject, pages: pages })
                        //TODO this is called when you click and drag the borders of a mark. So this is a good place to ask about updating similar marks.
                        //saveFile();
                        break;
                    }
                }
            });

            //Return true if a search result should not be displayed, either because it's overlapping an annotation
            //that's already there or because smart filters want to remove it.
            async function shouldFilter(result: SearchResult) {
                if (result.resultCode !== instance.Core.Search.ResultCode.FOUND) {
                    return false
                }

                let shouldFilter = false;
                if (smartFiltersToggle) {
                    const pageText = await getPageText(result.pageNum)
                    if (smartFilterManager.shouldFilter(result, pageText)) {
                        console.log('Smart Filtered')
                        shouldFilter = true
                    }
                }
                if (deduplicateSearchResultsToggle && !shouldFilter) {
                    //Check if each quad of the search result is covered by the quad of an annotation already on the page.
                    const annotationsOnPage = annotationManager.getAnnotationsList().filter(annotation => annotation.getPageNumber() === result.pageNum)
                    const isCovered = result.quads.every((quad: any) => isQuadFullyCovered(quad, annotationsOnPage))
                    if (isCovered) {
                        console.log('Deduplicated')
                        shouldFilter = true
                    }
                }
                return shouldFilter
            }
            //Send this method to the UI so that it's called for every search result.
            //@ts-ignore
            instance.addSearchFilter(shouldFilter)

            //#endregion
        });
    }, [loginInfo, setInstance, loaded]);

    return (
        <div className="body-container" style={{ flexDirection: "column" }}>
            <div className="DocViewer">
                <div className="webviewer" ref={viewer} style={{ height: "calc(100vh - 122px)" }}></div>
                {
                    sanitizationInProgress && <div className="progress-modal"><div className="spinner spinner-position-center"></div></div>
                }
            </div>
        </div>
    );
}

export interface SearchResult {
    resultCode: number,
    pageNum: number,
    resultStr: string,
    ambientStr: string,
    resultStrStart: number,
    resultStrEnd: number
    quads: any[]
}

//I'm writing custom code for checking if one rectangle contains another. PDFTron does have a method for this but it
//doesn't seem to work.
interface Rectangle {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

function contains(rect1: Rectangle, rect2: Rectangle): boolean {
    const tolerance = 1;

    return (
        rect1.x1 - tolerance <= rect2.x1 &&
        rect1.y1 - tolerance <= rect2.y1 &&
        rect1.x2 + tolerance >= rect2.x2 &&
        rect1.y2 + tolerance >= rect2.y2
    );
}

type log = {
    date: string,
    time: string,
    document: string,
    user?: string,
    roles?: string[],
    action: string,
    annotationType: string,
    pages: number[]
}

export enum logAction {
    DELETE = "Deleted Annotations",
    ADD = "Added Annotations",
    MODIFY = "Modified Annotations",
    APPLY = "Applied Redactions"
}

function convertHexStringToRgbArray(hexString: string): number[] {
    const red = parseInt(hexString.substring(1, 3), 16);
    const green = parseInt(hexString.substring(3, 5), 16);
    const blue = parseInt(hexString.substring(5, 7), 16);
    return [red, green, blue]
}

function getCurrentDate(): string {
    return ((new Date().getUTCMonth() + 1) + '/'
        + new Date().getUTCDate() + '/'
        + new Date().getUTCFullYear()
    )
}

function getCurrentTime(): string {
    return (new Date().getUTCHours() + ':'
        + new Date().getUTCMinutes() + ':'
        + new Date().getUTCSeconds()
    )
}

function uploadLogsToS3(logs: log[], name: string) {
    if (logs.length === 0) {
        return
    }
    const logsText: string = parseLogsArray(logs)
    const fileName = getLogS3Location(name)
    const file: File = new File([logsText], fileName, { type: "text/csv", });
    uploadLogs(file)
}

const logsHeaderRow = 'Date,Time,Document,User,Roles,Action,Annotation Type, Pages\n'

const parseLogsArray = (logs: log[]) => {
    let logsText: string = logsHeaderRow
    logs.forEach(log => {
        logsText += log.date + ',' + log.time + ',' + log.document + ',' + log.user + ',' + log.roles!.toString().replaceAll(',', ';') + ',' + log.action + ',' + log.annotationType + ',' + getPagesLogText(log.pages) + "\n"
    })
    //Delete trailing new line
    if (logsText.endsWith("\n")) {
        logsText = logsText.substring(0, logsText.length - 1)
    }
    return logsText
}

function getLogFileName(): string {
    return (new Date().getUTCMonth() + '-'
        + new Date().getUTCDay() + '-'
        + new Date().getUTCDate() + '-'
        + new Date().getUTCHours() + '-'
        + new Date().getUTCMinutes() + '-'
        + new Date().getUTCSeconds() + '-log'
    )
}

const getLogS3Location = (name: string) => {
    return name + '-logs/' + getLogFileName() + '.csv';
}

//This function is a UI improvement, if for example there was 3 changes on page 1. then the log text will show 1(3)
function getPagesLogText(pages: number[]) {
    let pagesAndAppearances: Map<number, number> = new Map();
    for (const num of pages) {
        if (pagesAndAppearances.has(num)) {
            pagesAndAppearances.set(num, pagesAndAppearances.get(num)! + 1)
        } else {
            pagesAndAppearances.set(num, 1)
        }
    }
    let logText = ''
    pagesAndAppearances.forEach((value: number, key: number) => {
        logText += key + '(' + value + '); '
    });
    //delete trailing '; ' symbol
    logText = logText.substring(0, logText.length - 2)
    return logText
}

const fileNamePattern = /^(.*?)(?:\s?\((\d+)\))?(\.[^.]+)$/;

//Return the file name with (1) at the end. If it already has (1), use (2), etc.
function incrementFileName(filename: string): string {
    const match = filename.match(fileNamePattern);

    if (match) {
        const baseName = match[1];
        const count = match[2] ? parseInt(match[2]) + 1 : 1;
        const extension = match[3];
        return `${baseName} (${count})${extension}`;
    }

    return `${filename} (1)`;
}
