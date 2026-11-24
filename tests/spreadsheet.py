import sys, time, pathlib
import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.table import TableSortField
from com.sun.star.sheet import TableFilterField

def prop(name, value):
    p = PropertyValue(); p.Name = name; p.Value = value; return p

local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
for i in range(100):
    try:
        ctx = resolver.resolve('uno:socket,host=127.0.0.1,port=8299;urp;StarOffice.ComponentContext'); break
    except Exception:
        if i == 99: raise
        time.sleep(0.1)
desktop = ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', ctx)
root = pathlib.Path(sys.argv[1])
doc = desktop.loadComponentFromURL((root / 'input.xlsx').as_uri(), '_blank', 0, (prop('Hidden', True), prop('UpdateDocMode', 0), prop('MacroExecutionMode', 4)))
assert doc is not None
try:
    sheet = doc.Sheets.getByName('수정요청서')
    captures = doc.Sheets.getByName('캡처 보기')
    assert captures.isProtected()
    assert captures.DrawPage.Count == 3
    assert '줄바꿈 한글 내용' in sheet.getCellByPosition(8, 1).String
    assert sheet.getCellByPosition(8, 2).Type.value == 'TEXT'
    field = TableSortField(); field.Field = 0; field.IsAscending = False
    area = sheet.getCellRangeByPosition(0, 0, 15, 3)
    area.sort((prop('SortFields', uno.Any('[]com.sun.star.table.TableSortField', (field,))), prop('ContainsHeader', True), prop('IsSortColumns', False)))
    numbers = [sheet.getCellByPosition(0, r).Value for r in range(1, 4)]
    assert numbers == [3, 2, 1], numbers
    for r in range(1, 4):
        no = int(sheet.getCellByPosition(0, r).Value)
        text = sheet.getCellByPosition(9, r)
        assert text.String == f'#{no} 캡처 보기'
        assert f'A{no+1}' in text.Formula and '"#' in text.Formula, text.Formula
    filtered = area.createFilterDescriptor(True)
    f = TableFilterField(); f.Field = 13; f.IsNumeric = False; f.StringValue = '완료'; f.Operator = uno.Enum('com.sun.star.sheet.FilterOperator', 'EQUAL')
    filtered.ContainsHeader = True; filtered.setFilterFields((f,)); area.filter(filtered)
    assert not sheet.Rows.getByIndex(1).IsVisible
    assert sheet.Rows.getByIndex(2).IsVisible
    assert not sheet.Rows.getByIndex(3).IsVisible
    filtered.setFilterFields(()); area.filter(filtered)
    sheet.getCellByPosition(11, 1).String = '수정 담당자'
    doc.storeAsURL((root / 'sorted.xlsx').as_uri(), (prop('FilterName', 'Calc MS Excel 2007 XML'), prop('Overwrite', True)))
finally:
    doc.close(True)
