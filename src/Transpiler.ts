import * as ts from "typescript";

import {TSHelper as tsEx} from "./TSHelper";
import {ForHelper} from "./ForHelper";

export class TranspileError extends Error {
    node: ts.Node;
    constructor(message: string, node: ts.Node) {
        super(message);
        this.node = node;
    }
}

export class LuaTranspiler {
    // Transpile a source file
    static transpileSourceFile(node: ts.SourceFile, checker: ts.TypeChecker): string {
        let transpiler = new LuaTranspiler(checker);
        return transpiler.transpileBlock(node);
    }

    indent: string;
    checker: ts.TypeChecker;
    genVarCounter: number;
    transpilingSwitch: boolean;

    constructor(checker: ts.TypeChecker) {
        this.indent = "";
        this.checker = checker;
        this.genVarCounter = 0;
        this.transpilingSwitch = false;
    }

    pushIndent(): void {
        this.indent = this.indent + "    ";
    }

    popIndent(): void {
        this.indent = this.indent.slice(4);
    }

    // Transpile a block
     transpileBlock(node: ts.Node): string {
        let result = "";

        if (ts.isBlock(node)) {
            node.statements.forEach(statement => {
                result += this.transpileNode(statement);
            });
        } else {
            node.forEachChild(child => {
                result += this.transpileNode(child);
            });
        }

        return result;
    }

    // Transpile a node of unknown kind.
    transpileNode(node: ts.Node): string {
        //Ignore declarations
        if (tsEx.getChildrenOfType(node, child => child.kind == ts.SyntaxKind.DeclareKeyword).length > 0) return "";

        switch (node.kind) {
            case ts.SyntaxKind.ImportDeclaration:
                return this.transpileImport(<ts.ImportDeclaration>node);
            case ts.SyntaxKind.ClassDeclaration:
                return this.transpileClass(<ts.ClassDeclaration>node);
            case ts.SyntaxKind.EnumDeclaration:
                return this.transpileEnum(<ts.EnumDeclaration>node);
            case ts.SyntaxKind.FunctionDeclaration:
                return this.transpileFunctionDeclaration(<ts.FunctionDeclaration>node);
            case ts.SyntaxKind.VariableStatement:
                return this.indent + this.transpileVariableStatement(<ts.VariableStatement>node) + "\n";
            case ts.SyntaxKind.ExpressionStatement:
                return this.indent + this.transpileExpression(<ts.Expression>tsEx.getChildren(node)[0]) + "\n";
            case ts.SyntaxKind.ReturnStatement:
                return this.indent + this.transpileReturn(<ts.ReturnStatement>node) + "\n";
            case ts.SyntaxKind.IfStatement:
                return this.transpileIf(<ts.IfStatement>node);
            case ts.SyntaxKind.WhileStatement:
                return this.transpileWhile(<ts.WhileStatement>node);
            case ts.SyntaxKind.ForStatement:
                return this.transpileFor(<ts.ForStatement>node);
            case ts.SyntaxKind.ForOfStatement:
                return this.transpileForOf(<ts.ForOfStatement>node);
            case ts.SyntaxKind.ForInStatement:
                return this.transpileForIn(<ts.ForInStatement>node);
            case ts.SyntaxKind.SwitchStatement:
                return this.transpileSwitch(<ts.SwitchStatement>node);
            case ts.SyntaxKind.BreakStatement:
                return this.transpileBreak();
            case ts.SyntaxKind.ContinueKeyword:
                // Disallow continue
                throw new TranspileError("Continue is not supported in Lua", node);
            case ts.SyntaxKind.TypeAliasDeclaration:
            case ts.SyntaxKind.InterfaceDeclaration:
            case ts.SyntaxKind.EndOfFileToken:
                // Ignore these
                return "";
            default:
                return this.indent + this.transpileExpression(node) + "\n";
        }
    }

    transpileImport(node: ts.ImportDeclaration): string {
        const name = this.transpileExpression(node.moduleSpecifier);
        const imports = node.importClause.namedBindings;
        if (ts.isNamespaceImport(imports)) {
            return `{$imports.name.escapedText} = require(${name})`;
        } else if (ts.isNamedImports(imports)) {
            // Forbid renaming
            imports.elements.forEach(element => {
                if(element.propertyName) {
                    throw new TranspileError("Renaming of individual imported objects is not allowed", node);
                }
            });
            return `require(${name})`;
        } else {
            throw new TranspileError("Unsupported import type.", node);
        }
    }

    transpileEnum(node: ts.EnumDeclaration): string {
        let val = 0;
        let result = "";

        const type = this.checker.getTypeAtLocation(node);
        const membersOnly = tsEx.isCompileMembersOnlyEnum(type);

        if (!membersOnly) {
            result += this.indent + `${node.name.escapedText}={}\n`;
        }

        node.members.forEach(member => {
            if (member.initializer) {
                if (ts.isNumericLiteral(member.initializer)) {
                    val = parseInt(member.initializer.text);
                } else {
                    throw new TranspileError("Only numeric initializers allowed for enums.", node);
                }
            }

            const name = (<ts.Identifier>member.name).escapedText;
            if (membersOnly) {
                result += this.indent + `${name}=${val}\n`;
            } else {
                result += this.indent + `${node.name.escapedText}.${name}=${val}\n`;
            }

            val++;
        });
        return result;
    }

    transpileBreak(): string {
        if (this.transpilingSwitch) {
            return this.indent + `goto switchDone${this.genVarCounter}\n`;
        } else {
            return this.indent + "break\n";
        }
    }

    transpileIf(node: ts.IfStatement): string {
        const condition = this.transpileExpression(node.expression);

        let result = this.indent + `if ${condition} then\n`;
        this.pushIndent();
        result += this.transpileStatement(node.thenStatement);
        this.popIndent();

        if (node.elseStatement) {
            result += this.indent + "else\n";
            this.pushIndent();
            result += this.transpileStatement(node.elseStatement);
            this.popIndent();
        }

        return result + this.indent + "end\n";
    }

    transpileWhile(node: ts.WhileStatement): string {
        const condition = this.transpileExpression(node.expression);

        let result = this.indent + `while ${condition} do\n`;
        this.pushIndent();
        result += this.transpileStatement(node.statement);
        this.popIndent();
        return result + this.indent + "end\n";
    }

    transpileFor(node: ts.ForStatement): string {
        // Get iterator variable
        const variable = (<ts.VariableDeclarationList>node.initializer).declarations[0];
        const identifier = <ts.Identifier>variable.name;

        // Populate three components of lua numeric for loop:
        let start = this.transpileExpression(variable.initializer);
        let end = ForHelper.GetForEnd(node.condition, this);
        let step = ForHelper.GetForStep(node.incrementor, this);

        // Add header
        let result = this.indent + `for ${identifier.escapedText}=${start},${end},${step} do\n`;

        // Add body
        this.pushIndent();
        result += this.transpileStatement(node.statement);
        this.popIndent();

        return result + this.indent + "end\n";
    }

    transpileForOf(node: ts.ForOfStatement): string {
        // Get variable identifier
        const variable =  (<ts.VariableDeclarationList>node.initializer).declarations[0];
        const identifier = <ts.Identifier>variable.name;

        // Transpile expression
        const expression = this.transpileExpression(node.expression);

        // Use ipairs for array types, pairs otherwise
        const isArray = tsEx.isArrayType(this.checker.getTypeAtLocation(node.expression));
        const pairs = isArray ? "ipairs" : "pairs";

        // Make header
        let result = this.indent + `for _, ${identifier.escapedText} in ${pairs}(${expression}) do\n`;

        // For body
        this.pushIndent();
        result += this.transpileStatement(node.statement);
        this.popIndent();

        return result + this.indent + "end\n";
    }

    transpileForIn(node: ts.ForInStatement): string {
        // Get variable identifier
        const variable = <ts.VariableDeclaration>(<ts.VariableDeclarationList>node.initializer).declarations[0];
        const identifier = <ts.Identifier>variable.name;

        // Transpile expression
        const expression = this.transpileExpression(node.expression);

        // Use ipairs for array types, pairs otherwise
        const isArray = tsEx.isArrayType(this.checker.getTypeAtLocation(node.expression));
        const pairs = isArray ? "ipairs" : "pairs";

        // Make header
        let result = this.indent + `for ${identifier.escapedText}, _ in ${pairs}(${expression}) do\n`;

        // For body
        this.pushIndent();
        result += this.transpileStatement(node.statement);
        this.popIndent();

        return result + this.indent + "end\n";
    }

    transpileStatement(node: ts.Statement): string {
        if (ts.isBlock(node)) {
            return this.transpileBlock(node);
        } else {
            return this.transpileNode(node);
        }
    }

    transpileSwitch(node: ts.SwitchStatement): string {
        const expression = this.transpileExpression(node.expression, true);
        const clauses = node.caseBlock.clauses;

        let result = this.indent + "-------Switch statement start-------\n";

        // If statement to go to right entry label
        clauses.forEach((clause, index) => {
            if (ts.isCaseClause(clause)) {
                let keyword = index == 0 ? "if" : "elseif";
                let condition = this.transpileExpression(clause.expression, true);
                result += this.indent + `${keyword} ${expression}==${condition} then\n`;
            } else {
                // Default
                result += this.indent + `else\n`;
            }

            this.pushIndent();

            // Labels for fallthrough
            result += this.indent + `::switchCase${this.genVarCounter+index}::\n`;

            this.transpilingSwitch = true;
            clause.statements.forEach(statement => {
                result += this.transpileNode(statement);
            });
            this.transpilingSwitch = false;

            // If this goto is reached, fall through to the next case
            if (index < clauses.length - 1) {
                result += this.indent + `goto switchCase${this.genVarCounter + index + 1}\n`;
            }

            this.popIndent();
        });
        result += this.indent + "end\n";
        result += this.indent + `::switchDone${this.genVarCounter}::\n`;
        result += this.indent + "--------Switch statement end--------\n";

        //Increment counter for next switch statement
        this.genVarCounter += clauses.length;
        return result;
    }

    transpileReturn(node: ts.ReturnStatement): string {
        return "return " + this.transpileExpression(node.expression);
    }

    transpileExpression(node: ts.Node, brackets?: boolean): string {
        switch (node.kind) {
            case ts.SyntaxKind.BinaryExpression:
                // Add brackets to preserve ordering
                return this.transpileBinaryExpression(<ts.BinaryExpression>node, brackets);
            case ts.SyntaxKind.ConditionalExpression:
                // Add brackets to preserve ordering
                return this.transpileConditionalExpression(<ts.ConditionalExpression>node, brackets);
            case ts.SyntaxKind.CallExpression:
                return this.transpileCallExpression(<ts.CallExpression>node);
            case ts.SyntaxKind.PropertyAccessExpression:
                return this.transpilePropertyAccessExpression(<ts.PropertyAccessExpression>node);
            case ts.SyntaxKind.ElementAccessExpression:
                return this.transpileElementAccessExpression(<ts.ElementAccessExpression>node);
            case ts.SyntaxKind.Identifier:
                // For identifiers simply return their name
                return (<ts.Identifier>node).text;
            case ts.SyntaxKind.StringLiteral:
                const text = (<ts.StringLiteral>node).text;
                return `"${text}"`;
            case ts.SyntaxKind.TemplateExpression:
                return this.transpileTemplateExpression(<ts.TemplateExpression>node);
            case ts.SyntaxKind.NumericLiteral:
                return (<ts.NumericLiteral>node).text;
            case ts.SyntaxKind.TrueKeyword:
                return "true";
            case ts.SyntaxKind.FalseKeyword:
                return "false";
            case ts.SyntaxKind.NullKeyword:
                return "nil";
            case ts.SyntaxKind.ThisKeyword:
                return "self";
            case ts.SyntaxKind.PostfixUnaryExpression:
                return this.transpilePostfixUnaryExpression(<ts.PostfixUnaryExpression>node);
            case ts.SyntaxKind.PrefixUnaryExpression:
                return this.transpilePrefixUnaryExpression(<ts.PrefixUnaryExpression>node);
            case ts.SyntaxKind.ArrayLiteralExpression:
                return this.transpileArrayLiteral(<ts.ArrayLiteralExpression>node);
            case ts.SyntaxKind.ObjectLiteralExpression:
                return this.transpileObjectLiteral(<ts.ObjectLiteralExpression>node);
            case ts.SyntaxKind.FunctionExpression:
            case ts.SyntaxKind.ArrowFunction:
                return this.transpileArrowFunction(<ts.ArrowFunction>node);
            case ts.SyntaxKind.NewExpression:
                return this.transpileNewExpression(<ts.NewExpression>node);
            case ts.SyntaxKind.ComputedPropertyName:
                return "[" + this.transpileExpression((<ts.ComputedPropertyName>node).expression) + "]";
            case ts.SyntaxKind.ParenthesizedExpression:
                return "(" + this.transpileExpression((<ts.ParenthesizedExpression>node).expression) + ")";
            case ts.SyntaxKind.SuperKeyword:
                return "self.__base";
            case ts.SyntaxKind.TypeAssertionExpression:
                // Simply ignore the type assertion
                return this.transpileExpression((<ts.TypeAssertion>node).expression);
            case ts.SyntaxKind.AsExpression:
                // Also ignore as casts
                return this.transpileExpression((<ts.AsExpression>node).expression);
            default:
                throw new TranspileError("Unsupported expression kind: " + tsEx.enumName(node.kind, ts.SyntaxKind), node);
        }
    }

    transpileBinaryExpression(node: ts.BinaryExpression, brackets?: boolean): string {
        // Transpile operands
        const lhs = this.transpileExpression(node.left, true);
        const rhs = this.transpileExpression(node.right, true);
        
        // Rewrite some non-existant binary operators
        let result = "";
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.PlusEqualsToken:
                result = `${lhs}=${lhs}+${rhs}`;
                break;
            case ts.SyntaxKind.MinusEqualsToken:
                result = `${lhs}=${lhs}-${rhs}`;
                break;
            case ts.SyntaxKind.AmpersandAmpersandToken:
                result = `${lhs} and ${rhs}`;
                break;
            case ts.SyntaxKind.BarBarToken:
                result = `${lhs} or ${rhs}`;
                break;
            case ts.SyntaxKind.AmpersandToken:
                result = `bit.band(${lhs},${rhs})`;
                break;
            case ts.SyntaxKind.BarToken:
                result = `bit.bor(${lhs},${rhs})`;
                break;
            case ts.SyntaxKind.PlusToken:
                // Replace string + with ..
                const typeLeft = this.checker.getTypeAtLocation(node.left);
                if (typeLeft.flags & ts.TypeFlags.String || ts.isStringLiteral(node.left))
                    return lhs + ".." + rhs;
            default:
                result = lhs + this.transpileOperator(node.operatorToken) + rhs;
        }

        // Optionally put brackets around result
        if (brackets) {
            return `(${result})`;
        } else {
            return result;
        }
    }

    transpileTemplateExpression(node: ts.TemplateExpression) {
        let parts = [`"${node.head.text}"`];
        node.templateSpans.forEach(span => {
            const expr = this.transpileExpression(span.expression, true);
            if (ts.isTemplateTail(span.literal)) {
                parts.push(expr + `.."${span.literal.text}"`);
            } else {
                parts.push(expr + `.."${span.literal.text}"`);
            }
        });
        return parts.join("..");
    }

    transpileConditionalExpression(node: ts.ConditionalExpression, brackets?: boolean): string {
        let condition = this.transpileExpression(node.condition);
        let val1 = this.transpileExpression(node.whenTrue);
        let val2 = this.transpileExpression(node.whenFalse);

        return `TS_ITE(${condition},function() return ${val1} end, function() return ${val2} end)`;
    }

    // Replace some missmatching operators
    transpileOperator<T extends ts.SyntaxKind>(operator: ts.Token<T>): string {
        switch (operator.kind) {
            case ts.SyntaxKind.EqualsEqualsEqualsToken:
                return "==";
            case ts.SyntaxKind.ExclamationEqualsToken:
            case ts.SyntaxKind.ExclamationEqualsEqualsToken:
                return "~=";
            default:
                return ts.tokenToString(operator.kind);
        }
    }

    transpilePostfixUnaryExpression(node: ts.PostfixUnaryExpression): string {
        const operand = this.transpileExpression(node.operand, true);
        switch (node.operator) {
            case ts.SyntaxKind.PlusPlusToken:
                return `${operand} = ${operand} + 1`;
            case ts.SyntaxKind.MinusMinusToken:
                return `${operand} = ${operand} - 1`;
            default:
                throw new TranspileError("Unsupported unary postfix: " + tsEx.enumName(node.kind, ts.SyntaxKind), node);
        }
    }

    transpilePrefixUnaryExpression(node: ts.PrefixUnaryExpression): string {
        const operand = this.transpileExpression(node.operand, true);
        switch (node.operator) {
            case ts.SyntaxKind.PlusPlusToken:
                return `${operand} = ${operand} + 1`;
            case ts.SyntaxKind.MinusMinusToken:
                return `${operand} = ${operand} - 1`;
            case ts.SyntaxKind.ExclamationToken:
                return `not ${operand}`;
            case ts.SyntaxKind.MinusToken:
                return `-${operand}`;
            default:
                throw new TranspileError("Unsupported unary prefix: " + tsEx.enumName(node.kind, ts.SyntaxKind), node);
        }
    }

    transpileNewExpression(node: ts.NewExpression): string {
        const name = this.transpileExpression(node.expression);
        const params = this.transpileArguments(node.arguments, ts.createTrue());

        return `${name}.new(${params})`;
    }

    transpileCallExpression(node: ts.CallExpression): string {
        // Check for calls on primitives to override
        if (ts.isPropertyAccessExpression(node.expression)) {
            const type = this.checker.getTypeAtLocation(node.expression.expression);
            switch (type.flags) {
                case ts.TypeFlags.String:
                case ts.TypeFlags.StringLiteral:
                    return this.transpileStringCallExpression(node);
                case ts.TypeFlags.Object:
                    if (tsEx.isArrayType(type))
                        return this.transpileArrayCallExpression(node);
            }

            // Include context parameter if present
            let callPath = this.transpileExpression(node.expression);
            const params = this.transpileArguments(node.arguments, node.expression.expression);
            return `${callPath}(${params})`;
        }

        // Handle super calls properly
        if (node.expression.kind == ts.SyntaxKind.SuperKeyword) {
            let callPath = this.transpileExpression(node.expression);
            const params = this.transpileArguments(node.arguments, <ts.Expression>ts.createNode(ts.SyntaxKind.ThisKeyword));
            return `self.__base.constructor(${params})`;
        }

        let callPath = this.transpileExpression(node.expression);
        const params = this.transpileArguments(node.arguments);
        return `${callPath}(${params})`;
    }

    transpileStringCallExpression(node: ts.CallExpression): string {
        const expression = <ts.PropertyAccessExpression>node.expression;
        const params = this.transpileArguments(node.arguments);
        const caller = this.transpileExpression(expression.expression);
        switch (expression.name.escapedText) {
            case "replace":
                return `string.sub(${caller},${params})`;
            case "indexOf":
                if (node.arguments.length == 1) {
                    return `(string.find(${caller},${params},1,true) or 0)-1`;
                } else {
                    return `(string.find(${caller},${params}+1,true) or 0)-1`;
                }
            default:
                throw new TranspileError("Unsupported string function: " + expression.name.escapedText, node);
        }
    }

    transpileArrayCallExpression(node: ts.CallExpression): string {
        const expression = <ts.PropertyAccessExpression>node.expression;
        const params = this.transpileArguments(node.arguments);
        const caller = this.transpileExpression(expression.expression);
        switch (expression.name.escapedText) {
            case "push":
                return `table.insert(${caller}, ${params})`;
            case "forEach":
                return `TS_forEach(${caller}, ${params})`;
            case "map":
                return `TS_map(${caller}, ${params})`;
            case "filter":
                return `TS_filter(${caller}, ${params})`;
            case "some":
                return `TS_some(${caller}, ${params})`;
            case "every":
                return `TS_every(${caller}, ${params})`;
            case "slice":
                return `TS_slice(${caller}, ${params})`
            default:
                throw new TranspileError("Unsupported array function: " + expression.name.escapedText, node);
        }
    }

    transpileArguments(params: ts.NodeArray<ts.Expression>, context?: ts.Expression): string {
        const parameters: string[] = [];

        // Add context as first param if present
        if (context) {
            parameters.push(this.transpileExpression(context));
        }

        params.forEach(param => {
            parameters.push(this.transpileExpression(param));
        });

        return parameters.join(",");
    }

    transpilePropertyAccessExpression(node: ts.PropertyAccessExpression): string {
        const property = node.name.text;
        
        // Check for primitive types to override
        const type = this.checker.getTypeAtLocation(node.expression);
        switch (type.flags) {
            case ts.TypeFlags.String:
            case ts.TypeFlags.StringLiteral:
                return this.transpileStringProperty(node);
            case ts.TypeFlags.Object:
                if (tsEx.isArrayType(type))
                    return this.transpileArrayProperty(node);
        }

        // Do not output path for member only enums
        if (tsEx.isCompileMembersOnlyEnum(type)) {
            return property;
        }

        let path = this.transpileExpression(node.expression);
        return `${path}.${property}`;
    }

    // Transpile access of string properties, only supported properties are allowed
    transpileStringProperty(node: ts.PropertyAccessExpression): string {
        const property = node.name;
        switch (property.escapedText) {
            case "length":
                return "#" + this.transpileExpression(node.expression);
            default:
                throw new TranspileError("Unsupported string property: " + property.escapedText, node);
        }
    }

    // Transpile access of array properties, only supported properties are allowed
    transpileArrayProperty(node: ts.PropertyAccessExpression): string {
        const property = node.name;
        switch (property.escapedText) {
            case "length":
                return "#" + this.transpileExpression(node.expression);
            default:
                throw new TranspileError("Unsupported array property: " + property.escapedText, node);
        }
    }

    transpileElementAccessExpression(node: ts.ElementAccessExpression): string {
        const element = this.transpileExpression(node.expression);
        const index = this.transpileExpression(node.argumentExpression);

        const type = this.checker.getTypeAtLocation(node.expression);
        if (tsEx.isArrayType(type) || tsEx.isTupleType(type)) {
            return `${element}[${index}+1]`;
        } else if (tsEx.isStringType(type)) {
            return `string.sub(${element},${index}+1,${index}+1)`;
        } else {
            return `${element}[${index}]`;
        }
    }

    // Transpile a variable statement
    transpileVariableStatement(node: ts.VariableStatement): string {
        let result = "";

        node.declarationList.declarations.forEach(declaration => {
            result += this.transpileVariableDeclaration(<ts.VariableDeclaration>declaration);
        });

        return result;
    }

    transpileVariableDeclaration(node: ts.VariableDeclaration): string {
        if (ts.isIdentifier(node.name)) {
            // Find variable identifier
            const identifier = node.name;
            if (node.initializer) {
                const value = this.transpileExpression(node.initializer);
                return `local ${identifier.escapedText} = ${value}`;
            } else {
                return `local ${identifier.escapedText} = nil`;
            }
        } else if (ts.isArrayBindingPattern(node.name)) {
            // Destructuring type
            const value = this.transpileExpression(node.initializer);
            let parentName = `__destr${this.genVarCounter}`;
            this.genVarCounter++;
            let result = `local ${parentName} = ${value}\n`;
            node.name.elements.forEach((elem: ts.BindingElement, index: number) => {
                if (!elem.dotDotDotToken) {
                    result += this.indent + `local ${(<ts.Identifier>elem.name).escapedText} = ${parentName}[${index + 1}]\n`;
                } else {
                    result += this.indent + `local ${(<ts.Identifier>elem.name).escapedText} = TS_slice(${parentName}, ${index})\n`;
                }
            });
            return result;
        } else {
            throw new TranspileError("Unsupported variable declaration type " + tsEx.enumName(node.name.kind, ts.SyntaxKind), node);
        }
    }

    transpileFunctionDeclaration(node: ts.FunctionDeclaration): string {
        let result = "";
        const identifier = node.name;
        const methodName = identifier.escapedText;
        const parameters = node.parameters
        const body = node.body;

        // Build parameter string
        let paramNames: string[] = [];
        parameters.forEach(param => {
            paramNames.push(<string>(<ts.Identifier>param.name).escapedText);
        });

        // Build function header
        result += this.indent + `function ${methodName}(${paramNames.join(",")})\n`;

        this.pushIndent();
        result += this.transpileBlock(body);
        this.popIndent();

        // Close function block
        result += this.indent + "end\n";

        return result;
    }

    transpileMethodDeclaration(node: ts.MethodDeclaration, path: string): string {
        let result = "";
        const identifier = <ts.Identifier>node.name;
        const methodName = identifier.escapedText;
        const parameters = node.parameters;
        const body = node.body;

        // Build parameter string
        let paramNames: string[] = ["self"];
        parameters.forEach(param => {
            paramNames.push(<string>(<ts.Identifier>param.name).escapedText);
        });

        // Build function header
        result += this.indent + `function ${path}${methodName}(${paramNames.join(",")})\n`;

        this.pushIndent();
        result += this.transpileBlock(body);
        this.popIndent();

        // Close function block
        result += this.indent + "end\n";

        return result;
    }

    // Transpile a class declaration
    transpileClass(node: ts.ClassDeclaration): string {
        // Find extends class, ignore implements
        let extendsType;
        let noClassOr = false;
        if (node.heritageClauses) node.heritageClauses.forEach(clause => {
            if (clause.token == ts.SyntaxKind.ExtendsKeyword) {
                const superType = this.checker.getTypeAtLocation(clause.types[0]);
                // Ignore purely abstract types (decorated with /** @PureAbstract */)
                if (!tsEx.isPureAbstractClass(superType)) {
                    extendsType = clause.types[0];
                }
                noClassOr = tsEx.hasCustomDecorator(superType, "!NoClassOr");
            }
        });

        let className = <string>node.name.escapedText;
        let result = "";

        // Skip header if this is an extension class
        var isExtension = tsEx.isExtensionClass(this.checker.getTypeAtLocation(node));
        if (!isExtension) {
            // Write class declaration
            const classOr = noClassOr ? "" : `${className} or `;
            if (!extendsType) {
                result += this.indent + `${className} = ${classOr}{}\n`;
            } else {
                const baseName = (<ts.Identifier>extendsType.expression).escapedText;
                result += this.indent + `${className} = ${classOr}${baseName}.new()\n`
            }
            result += this.indent + `${className}.__index = ${className}\n`;
            if (extendsType) {
                    const baseName = (<ts.Identifier>extendsType.expression).escapedText;
                    result += this.indent + `${className}.__base = ${baseName}\n`;
            }
            result += this.indent + `function ${className}.new(construct, ...)\n`;
            result += this.indent + `    local instance = setmetatable({}, ${className})\n`;
            result += this.indent + `    if construct and ${className}.constructor then ${className}.constructor(instance, ...) end\n`;
            result += this.indent + `    return instance\n`;
            result += this.indent + `end\n`;
        } else {
            // Overwrite the original className with the class we are overriding for extensions
            if (extendsType) {
                className = <string>(<ts.Identifier>extendsType.expression).escapedText;
            }
        }

        // Get all properties with value
        const properties = node.members.filter(ts.isPropertyDeclaration)
            .filter(_ => _.initializer);

        // Divide properties into static and non-static
        const isStatic = _ => _.modifiers && _.modifiers.some(_ => _.kind == ts.SyntaxKind.StaticKeyword);
        const staticFields = properties.filter(isStatic);
        const instanceFields = properties.filter(_ => !isStatic(_));

        // Add static declarations
        for (const field of staticFields) {
            const fieldName = (<ts.Identifier>field.name).escapedText;
            let value = this.transpileExpression(field.initializer);            
            result += this.indent + `${className}.${fieldName} = ${value}\n`;
        }

        // Try to find constructor
        const constructor = node.members.filter(ts.isConstructorDeclaration)[0];
        if (constructor) {
            // Add constructor plus initialisation of instance fields
            result += this.transpileConstructor(constructor, className, instanceFields);
        } else {
            // No constructor, make one to set all instance fields if there are any
            if (instanceFields.length > 0) {
                // Create empty constructor and add instance fields
                result += this.transpileConstructor(ts.createConstructor([],[],[], ts.createBlock([],true)), className, instanceFields);
            }
        }

        // Transpile methods
        node.members.filter(ts.isMethodDeclaration).forEach(method => {
            result += this.transpileMethodDeclaration(method, `${className}.`);
        });

        return result;
    }

    transpileConstructor(node: ts.ConstructorDeclaration, className: string, instanceFields: ts.PropertyDeclaration[]): string {
        const extraInstanceFields = [];

        let parameters = ["self"];
        node.parameters.forEach(param => {
            // If param has decorators, add extra instance field
            if (param.modifiers != undefined) extraInstanceFields.push(<string>(<ts.Identifier>param.name).escapedText);
            // Add to parameter list
            parameters.push(<string>(<ts.Identifier>param.name).escapedText);
        });

        let result = this.indent + `function ${className}.constructor(${parameters.join(",")})\n` ;

        // Add in instance field declarations
        for (const f of extraInstanceFields) {
            result += this.indent + `    self.${f} = ${f}\n`;
        }

        for (const f of instanceFields) {
            // Get identifier
            const fieldIdentifier = <ts.Identifier>f.name;
            const fieldName = fieldIdentifier.escapedText;

            let value = this.transpileExpression(f.initializer);

            result += this.indent + `    self.${fieldName} = ${value}\n`;
        }

        // Transpile constructor body
        this.pushIndent();
        result += this.transpileBlock(node.body);
        this.popIndent();

        return result + this.indent + "end\n";
    }

    transpileArrayLiteral(node: ts.ArrayLiteralExpression): string {
        let values: string[] = [];

        node.elements.forEach(child => {
            values.push(this.transpileExpression(child));
        });

        return "{" + values.join(",") + "}";
    }

    transpileObjectLiteral(node: ts.ObjectLiteralExpression): string {
        let properties: string[] = [];
        // Add all property assignments
        node.properties.forEach(assignment => {
            const [key, value] = tsEx.getChildren(assignment);
            if (ts.isIdentifier(key)) {
                properties.push(`${key.escapedText}=`+this.transpileExpression(value));
            } else if (ts.isComputedPropertyName(key)) {
                const index = this.transpileExpression(key);
                properties.push(`${index}=`+this.transpileExpression(value));
            } else {
                const index = this.transpileExpression(<ts.Expression>key);
                properties.push(`[${index}]=`+this.transpileExpression(value));
            }
        });

        return "{" + properties.join(",") + "}";
    }

    transpileFunctionExpression(node: ts.FunctionExpression): string {
        // Build parameter string
        let paramNames: string[] = [];
        node.parameters.forEach(param => {
            paramNames.push(<string>(<ts.Identifier>param.name).escapedText);
        });

        let result = `function(${paramNames.join(",")})\n`;
        this.pushIndent();
        result += this.transpileBlock(node.body);
        this.popIndent();
        return result + this.indent + "end\n";
    }

    transpileArrowFunction(node: ts.ArrowFunction): string {
        // Build parameter string
        let paramNames: string[] = [];
        node.parameters.forEach(param => {
            paramNames.push(<string>(<ts.Identifier>param.name).escapedText);
        });

        if (ts.isBlock(node.body)) {
            let result = `function(${paramNames.join(",")})\n`;
            this.pushIndent();
            result += this.transpileBlock(node.body);
            this.popIndent();
            return result + this.indent + "end\n";
        } else {
            return `function(${paramNames.join(",")}) return ` + this.transpileExpression(node.body) + " end";
        }
    }
}