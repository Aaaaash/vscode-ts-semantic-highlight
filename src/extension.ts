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
	text: string;
	fullText: string;
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
	ts.forEachChild(node, (child) => {
		const symbol = typeChecker.getSymbolAtLocation(child);
		if (symbol) {

			symbols.push({
				text: symbol.name,
				range: {
					start: child.pos,
					end: child.end,
				},
				kind: symbol.flags,
			});
		}
		
		visitor(typeChecker, child, symbols);
	});

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
		const uriString = document.uri.toString();
		const typeChecker = typeCheckers.get(uriString);
		let newSourceFile = sourceFiles.get(uriString);
		if (newSourceFile && typeChecker) {
			for (const changeBuffer of changesBuffer) {
				const { start, end, text, fullText } = changeBuffer;
				const newLength = fullText.length;
				const textChangeRange = ts.createTextChangeRange(
					ts.createTextSpan(
						0,
						newSourceFile.text.length,
					),
					newLength,
				);
				newSourceFile = ts.updateSourceFile(
					newSourceFile,
					fullText,
					textChangeRange,
				);
			}

			const semanticSymbols: SimpleSymbol[] = [];
			for (const statement of newSourceFile.statements) {
				visitor(typeChecker, statement, semanticSymbols);
			}
			if (semanticSymbols.length > 0) {
				const decorations = makeDecoration(semanticSymbols);
				cachedDecorations.set(document.uri.toString(), decorations);
				setDecorations(editor, decorations);
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
				const { range, text } = change;

				const changesStart = document.offsetAt(new vscode.Position(range.start.line, range.start.character));
				const changesEnd = document.offsetAt(new vscode.Position(range.end.line, range.end.character));
				changesBuffer.push({ start: changesStart, end: changesEnd, text, fullText: document.getText(), });
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
						const defaultCompilerOptions = ts.getDefaultCompilerOptions();
						console.log(defaultCompilerOptions);
						const program = ts.createProgram(
							[document.fileName],
							{
								...defaultCompilerOptions,
								checkJs: true,
								allowJs: true,
							}
						);
						const typeChecker = program.getTypeChecker();
						typeCheckers.set(document.uri.toString(), typeChecker);
						const sourceFile = sourceFiles.get(document.uri.toString()) || program.getSourceFile(document.fileName);
						if (sourceFile) {
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
