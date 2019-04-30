// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as ts from "typescript";

import { logger } from "./logger";
import { minProperty, maxProperty } from "./utils";
import { semanticHighlightFlags } from "./common";

interface SimpleSymbol {
	range: { start: number, end: number };
	kind: number;
	text: string;
}

function isNeedsemantic(flag: number) {
	// @ts-ignore
	return Object.keys(semanticHighlightFlags).find((key: string) => semanticHighlightFlags[key] === flag);
}

const maxTextChangeBufferLength = 20;

interface TextChangeBufferItem {
	start: number;
	end: number;
}

interface TextEditorDecoration {
	decoration: vscode.TextEditorDecorationType,
	range: {
		start: number;
		end: number;
	}
};

function setDecorations(textEditor: vscode.TextEditor, decorations: TextEditorDecoration[]) {
	const document = textEditor.document;
	for (const { decoration, range } of decorations) {
		const codeRange = new vscode.Range(
			document.positionAt(range.start),
			document.positionAt(range.end),
		);

		textEditor.setDecorations(
			decoration,
			[codeRange]
		);
	}
}

function findChildrenByRange(node: ts.Node, fileName: string, range: { start: number, end: number }, children: ts.Node[]) {
	ts.forEachChild(node, (child: ts.Node) => {
		const { pos, end } = child;

		// const sourceFile = child.getSourceFile();
		if (pos <= range.start && end >= range.end) {
			logger.appendLine(`start: ${child.pos}, end: ${range.end}`);
			children.push(child);
			findChildrenByRange(child, fileName, range, children);
		}
	});
}

function makeDecorationType(color: string, bold: boolean, fontStyle: string): vscode.TextEditorDecorationType {
	return vscode.window.createTextEditorDecorationType({
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		color,
		fontWeight: bold ? "bold" : "normal",
		fontStyle,
	});
}


function visitor(typeChecker: ts.TypeChecker, node: ts.Node, symbols: SimpleSymbol[]) {
	let symbol;
	try {
		symbol = typeChecker.getSymbolAtLocation(node);
		if (symbol) {

			symbols.push({
				text: symbol.name,
				range: {
					start: node.pos,
					end: node.end,
				},
				kind: symbol.flags,
			});
		}
		ts.forEachChild(node, (child) => {
			visitor(typeChecker, child, symbols);
		});
	} catch(e) {
		console.error(e.message || "Can't found symbol!");
	}
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const cachedDecorations = new Map<string, Array<TextEditorDecoration>>();
	const sourceFiles = new Map<string, ts.SourceFile>();
	const typeCheckers = new Map<string, ts.TypeChecker>();
	let textChangeBuffer = new Map<string, Array<TextChangeBufferItem>>();

	const config = vscode.workspace.getConfiguration("semantic-highlighting-ts");
	function makeDecoration(symbols: SimpleSymbol[]): TextEditorDecoration[] {
		const decorations = [];
		for (const symbol of symbols) {
			if (
				symbol.kind === semanticHighlightFlags.TypeParameter ||
				symbol.kind === semanticHighlightFlags.TypeAlias
			) {
				const color = config.get("ts-highlighting.colors.typeParameter", "#d8cb9a") || "#d8cb9a";
				const decoration = makeDecorationType(color, true, "normal");
				decorations.push({
					decoration,
					range: symbol.range,
				});
			} else if (
				symbol.kind === semanticHighlightFlags.BlockScopedVariable ||
				symbol.kind === semanticHighlightFlags.Type ||
				symbol.kind === semanticHighlightFlags.Variable
			) {
				const color = config.get("ts-highlighting.colors.variable", "#b6b9ea") || "#b6b9ea";
				const decoration = makeDecorationType(color, false, "normal");
				decorations.push({
					decoration,
					range: symbol.range,
				});

			} else if (
				symbol.kind === semanticHighlightFlags.FunctionScopedVariable
			) {
				const color = config.get("ts-highlighting.colors.functionScopedVariable", "#eaacbf") || "#eaacbf";
				const decoration = makeDecorationType(color, false, "italic");
				decorations.push({ range: symbol.range, decoration });
			} else if (
				symbol.kind === semanticHighlightFlags.Enum ||
				symbol.kind === semanticHighlightFlags.ConstEnum
			) {
				const color = config.get("ts-highlighting.colors.enums", "#77d1e5") || "#77d1e5";
				const decoration = makeDecorationType(color, false, "normal");
				decorations.push({ range: symbol.range, decoration });
			} else if (
				symbol.kind === semanticHighlightFlags.EnumMember
			) {
				const color = config.get("ts-highlighting.colors.enums", "#ebaea7") || "#ebaea7";
				const decoration = makeDecorationType(color, false, "normal");
				decorations.push({ range: symbol.range, decoration });
			}
		}
		return decorations;
	}

	function doIncrementalHighlight(editor: vscode.TextEditor, changesBuffer: TextChangeBufferItem[], document: vscode.TextDocument) {
		const minStart = minProperty(changesBuffer, "start");
		const maxEnd = maxProperty(changesBuffer, "end");

		console.log(`start: ${minStart} - end: ${maxEnd}`);
		const uriString = document.uri.toString();

		const typeChecker = typeCheckers.get(uriString);
		const sourceFile = sourceFiles.get(uriString);

		if (sourceFile) {
			const textChangeRange = ts.createTextChangeRange(
				ts.createTextSpan(0, sourceFile.getFullText().length),
				document.getText().length,
			);

			const newSourceFile = ts.updateSourceFile(
				sourceFile,
				document.getText(),
				textChangeRange,
				true
			);
			sourceFiles.set(uriString, newSourceFile);
			const node = newSourceFile.statements.find((child) => child.pos <= minStart && child.end >= maxEnd);
			if (node && typeChecker) {
				const semanticSymbols: SimpleSymbol[] = [];
				visitor(typeChecker, newSourceFile, semanticSymbols);
				if (semanticSymbols.length > 0) {
					for (const textEditor of vscode.window.visibleTextEditors) {
						if (textEditor && textEditor.document.uri.toString() === document.uri.toString()) {
							const decorations = makeDecoration(semanticSymbols);
							cachedDecorations.set(document.uri.toString(), decorations);
							setDecorations(editor, decorations);
						}
					}
				}
			}
		}
	}

	function handleTextDocumentChange(e: vscode.TextDocumentChangeEvent) {
		if (e.document.uri.scheme !== "file") {
			return;
		}

		const { document, contentChanges } = e;
		const urlString = document.uri.toString();
		const currentEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === urlString);
		if (currentEditor) {
			const sourceFile = sourceFiles.get(urlString);
			if (!sourceFile) {
				logger.appendLine("[ERROR] - We lost document!");
				return;
			}
			const changesBuffer: Array<TextChangeBufferItem> = [];
			for (const change of contentChanges) {
				const { range } = change;

				const start = document.offsetAt(new vscode.Position(range.start.line, range.start.character));
				const end = document.offsetAt(new vscode.Position(range.end.line, range.end.character));
				logger.appendLine(`Trigger - ${e.document.uri.toString()}, start: ${start} end: ${end}`);
				changesBuffer.push({ start, end });
			}

			const existBuffer = textChangeBuffer.get(urlString);

			if (existBuffer) {
				const newBuffer = existBuffer.concat(changesBuffer);
				
				if (newBuffer.length >= maxTextChangeBufferLength) {
					doIncrementalHighlight(currentEditor, newBuffer, document);
					textChangeBuffer.delete(urlString);
				} else {
					textChangeBuffer.set(urlString, newBuffer);
				}
			} else {
				textChangeBuffer.set(urlString, changesBuffer);
			}
		}
	}

	// const throttledEventHandler = throttle(handleTextDocumentChange, 500);
	vscode.workspace.onDidChangeTextDocument(handleTextDocumentChange);

	vscode.window.onDidChangeActiveTextEditor(
		(editor?: vscode.TextEditor) => {
			if (editor) {
				const document = editor.document;
				if (
					document.languageId === "typescript" ||
					document.languageId === "typescriptreact" ||
					document.languageId === "javascript" ||
					document.languageId === "typescriptreact"
				) {
					logger.appendLine(`Open file: ${document.fileName}`);
					const cachedDecoration = cachedDecorations.get(document.uri.toString());
					if (cachedDecoration) {
						setDecorations(editor, cachedDecoration);
					} else {
						const program = ts.createProgram([document.fileName], ts.getDefaultCompilerOptions());
						const typeChecker = program.getTypeChecker();
						typeCheckers.set(document.uri.toString(), typeChecker);
						const sourceFile = sourceFiles.get(document.uri.toString()) || program.getSourceFile(document.fileName);
						if (sourceFile) {
							console.log(sourceFile.statements);
							sourceFiles.set(document.uri.toString(), sourceFile);
							const semanticSymbols: SimpleSymbol[] = [];
							if (sourceFile) {
								visitor(typeChecker, sourceFile, semanticSymbols);

								if (semanticSymbols.length > 0) {
									for (const textEditor of vscode.window.visibleTextEditors) {
										if (textEditor && textEditor.document.uri.toString() === document.uri.toString()) {
											const decorations = makeDecoration(semanticSymbols);
											cachedDecorations.set(document.uri.toString(), decorations);
											setDecorations(editor, decorations);
										}
									}
								}
							}
						}
					}
				}
			}
		}
	)

}

// this method is called when your extension is deactivated
export function deactivate() { }
