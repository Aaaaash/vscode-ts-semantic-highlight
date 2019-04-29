// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as ts from "typescript";

const SematicHighlightFlags = {
	FunctionScopedVariable: 1,
	BlockScopedVariable: 2,
	Variable: 3,
	Enum: 384,
	ConstEnum: 128,
	EnumMember: 8,
	Method: 8192,
	GetAccessor: 32768,
	SetAccessor: 65536,
	Signature: 131072,
	TypeParameter: 262144,
	TypeAlias: 524288,
	Alias: 2097152,
	Type: 67897832,
	ExportStar: 8388608,
	Optional: 16777216,
	FunctionScopedVariableExcludes: 67220414,
	BlockScopedVariableExcludes: 67220415,
	ParameterExcludes: 67220415,
	EnumMemberExcludes: 68008959,
	FunctionExcludes: 67219887,
	NamespaceModuleExcludes: 0,
	GetAccessorExcludes: 67154879,
	SetAccessorExcludes: 67187647,
	TypeParameterExcludes: 67635688,
	TypeAliasExcludes: 67897832,
	AliasExcludes: 2097152,
	PropertyOrAccessor: 98308,
}

interface SimpleSymbol {
	range: { start: number, end: number };
	kind: number;
	text: string;
	parentKind: number,
}

function isNeedSematic(flag: number) {
	// @ts-ignore
	return Object.keys(SematicHighlightFlags).find((key: string) => SematicHighlightFlags[key] === flag);
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

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const logger = vscode.window.createOutputChannel('sematic-highlighting-ts');
	const cachedDecorations = new Map<string, Array<TextEditorDecoration>>();

	function visitor(typeChecker: ts.TypeChecker, node: ts.Node, symbols: SimpleSymbol[]) {
		const symbol = typeChecker.getSymbolAtLocation(node);
		if (symbol && isNeedSematic(symbol.flags)) {
			symbols.push({
				text: symbol.name,
				range: {
					start: node.pos,
					end: node.end,
				},
				kind: symbol.flags,
				parentKind: node.parent.kind,
			});
		}
		ts.forEachChild(node, (child) => {
			visitor(typeChecker, child, symbols);
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

	const config = vscode.workspace.getConfiguration("sematic-highlighting-ts");
	function makeDecoration(symbols: SimpleSymbol[]): TextEditorDecoration[] {
		const decorations = [];
		console.log(config);
		for (const symbol of symbols) {
			if (
				symbol.kind === SematicHighlightFlags.TypeParameter ||
				symbol.kind === SematicHighlightFlags.TypeAlias
			) {
				const color = config.get("ts-highlighting.colors.typeParameter", "#d8cb9a") || "#d8cb9a";
				const decoration = makeDecorationType(color, true, "normal");
				decorations.push({
					decoration,
					range: symbol.range,
				});
			} else if (
				symbol.kind === SematicHighlightFlags.BlockScopedVariable ||
				symbol.kind === SematicHighlightFlags.Type ||
				symbol.kind === SematicHighlightFlags.Variable
			) {
				const color = config.get("ts-highlighting.colors.variable", "#b6b9ea") || "#b6b9ea";
				const decoration = makeDecorationType(color, false, "normal");
				decorations.push({
					decoration,
					range: symbol.range,
				});

			} else if (
				symbol.kind === SematicHighlightFlags.FunctionScopedVariable
			) {
				const color = config.get("ts-highlighting.colors.functionScopedVariable", "#eaacbf") || "#eaacbf";
				const decoration = makeDecorationType(color, false, "italic");
				decorations.push({ range: symbol.range, decoration });
			} else if (
				symbol.kind === SematicHighlightFlags.Enum ||
				symbol.kind === SematicHighlightFlags.ConstEnum
			) {
				const color = config.get("ts-highlighting.colors.enums", "#77d1e5") || "#77d1e5";
				const decoration = makeDecorationType(color, false, "normal");
				decorations.push({ range: symbol.range, decoration });
			} else if (
				symbol.kind === SematicHighlightFlags.EnumMember
			) {
				const color = config.get("ts-highlighting.colors.enums", "#ebaea7") || "#ebaea7";
				const decoration = makeDecorationType(color, false, "normal");
				decorations.push({ range: symbol.range, decoration });
			}
		}
		return decorations;
	}

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
						const sourceFile = program.getSourceFile(document.fileName);
						const sematicSymbols: SimpleSymbol[] = [];
						if (sourceFile) {
							visitor(typeChecker, sourceFile, sematicSymbols);
	
							if (sematicSymbols.length > 0) {
								for (const textEditor of vscode.window.visibleTextEditors) {
									if (textEditor && textEditor.document.uri.toString() === document.uri.toString()) {
										const decorations = makeDecoration(sematicSymbols);
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
	)

}

// this method is called when your extension is deactivated
export function deactivate() {}
