package com.legal.scraper.util;

import org.apache.commons.csv.CSVFormat;
import org.apache.commons.csv.CSVParser;
import org.apache.commons.csv.CSVRecord;
import org.apache.poi.ss.usermodel.*;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class BarcodeParser {

    private static final Pattern BARCODE_PATTERN = Pattern.compile("(?i)[a-z]{2}\\d{9}[a-z]{2}");

    public static Set<String> parseBarcodes(InputStream is, String originalName) throws Exception {
        Set<String> barcodes = new HashSet<>();
        String fileExt = originalName.toLowerCase();

        System.out.println("Parsing barcodes from file: " + originalName);

        if (fileExt.endsWith(".csv")) {
            try (Reader reader = new InputStreamReader(is);
                 CSVParser csvParser = new CSVParser(reader, CSVFormat.DEFAULT)) {
                
                for (CSVRecord record : csvParser) {
                    for (String cell : record) {
                        String cleanStr = cell.replaceAll("[^a-zA-Z0-9]", "");
                        Matcher m = BARCODE_PATTERN.matcher(cleanStr);
                        while (m.find()) {
                            barcodes.add(m.group().toUpperCase().trim());
                        }
                    }
                }
            }
        } else if (fileExt.endsWith(".xlsx") || fileExt.endsWith(".xls")) {
            try (Workbook workbook = WorkbookFactory.create(is)) {
                Sheet sheet = workbook.getSheetAt(0);
                for (Row row : sheet) {
                    for (Cell cell : row) {
                        if (cell.getCellType() == CellType.STRING || cell.getCellType() == CellType.NUMERIC) {
                            String cellValue = cell.toString();
                            String cleanStr = cellValue.replaceAll("[^a-zA-Z0-9]", "");
                            Matcher m = BARCODE_PATTERN.matcher(cleanStr);
                            while (m.find()) {
                                barcodes.add(m.group().toUpperCase().trim());
                            }
                        }
                    }
                }
            }
        } else {
            throw new IllegalArgumentException("Unsupported file type: " + originalName);
        }

        if (barcodes.isEmpty()) {
            throw new Exception("The file is valid, but no barcodes (like JF123456789IN) were detected.");
        }

        System.out.println("Found " + barcodes.size() + " unique barcodes.");
        return barcodes;
    }
}
