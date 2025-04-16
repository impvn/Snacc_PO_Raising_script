from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import NoSuchElementException, TimeoutException
from webdriver_manager.chrome import ChromeDriverManager
import gspread
from gspread_dataframe import set_with_dataframe
from gspread.exceptions import WorksheetNotFound
from google.auth import default
from oauth2client.service_account import ServiceAccountCredentials
import pandas as pd
from datetime import datetime
import time
import os
import traceback

def setup_driver():
    chrome_options = Options()
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--window-size=1920x1080")
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=chrome_options)
    return driver

def login(driver, wait, user_id, password):
    try:
        email_mobile_field = wait.until(EC.presence_of_element_located((By.NAME, "username")))
        email_mobile_field.send_keys(user_id)
        password_field = wait.until(EC.presence_of_element_located((By.ID, "id_password")))
        password_field.send_keys(password)
        login_button = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[@type='submit']")))
        login_button.click()
        print("Login Successful")
    except TimeoutException:
        print("Login inputs not available or timed out.")

def select_suggestion(wait, input_element, value):
    input_element.send_keys(value)
    try:
        suggestions = wait.until(EC.presence_of_all_elements_located((By.CSS_SELECTOR, "ul.md-autocomplete-suggestions li")))
        for suggestion in suggestions:
            if value.lower() in suggestion.text.lower():
                suggestion.click()
                break
    except TimeoutException:
        print(f"Suggestion not found for: {value}")

def retry_click(driver, element, retries=3):
    for _ in range(retries):
        try:
            if element.is_enabled():
                driver.execute_script("arguments[0].click();", element)
                return True
        except Exception as e:
            print(f"Retrying click due to: {e}")
    return False

def submit(driver):
    try:
        save_and_send_button = driver.find_element(By.XPATH, "/html/body/md-content/section/ui-view/section/div/div/div/md-toolbar[2]/div/div[2]/button[2]/span")
        return retry_click(driver, save_and_send_button)
    except NoSuchElementException:
        print("Submit button not found.")
        return False

def prepare_csv_files_from_sheets(client, sheet_name, transformed_sheet_name, output_directory):
    try:
        transformed_sheet = client.open(sheet_name).worksheet(transformed_sheet_name)
        df = pd.DataFrame(transformed_sheet.get("A1:I")[1:], columns=transformed_sheet.get("A1:I")[0])

        mapping_sheet = client.open(sheet_name).worksheet("Listed Pods")
        mapping_df = pd.DataFrame(mapping_sheet.get("A1:C")[1:], columns=mapping_sheet.get("A1:C")[0])

        df = pd.merge(df, mapping_df, how='left', on='Location').dropna()
        grouped_dfs = dict(tuple(df.groupby(['Vendor', 'Location', 'Date', 'Slot'])))

        os.makedirs(output_directory, exist_ok=True)

        vendor_sheet_cache = {}
        vendor_po_sheet = client.open("Vendor_Wise_PO_Template")
        all_vendor_names = df['Vendor'].unique()

        for vendor in all_vendor_names:
            try:
                sheet = vendor_po_sheet.worksheet(vendor)
                vendor_df = pd.DataFrame(sheet.get("A1:S")[1:], columns=sheet.get("A1:S")[0])
                vendor_sheet_cache[vendor] = vendor_df
            except WorksheetNotFound:
                print(f"Vendor sheet not found for: {vendor}. Skipping vendor.")
                continue

        csv_file_map = []

        for (vendor, location, date, slot), group_df in grouped_dfs.items():
            if vendor not in vendor_sheet_cache:
                print(f"Skipping {vendor}: No cached vendor sheet found.")
                continue

            formatted_date = date.replace('-', '_').replace('/', '_')
            filename = f"{vendor}_{slot}_{location}_{formatted_date}.csv".replace(" ", "_")
            file_path = os.path.join(output_directory, filename)

            try:
                vendor_sheet_df = vendor_sheet_cache[vendor]
                merged_df = pd.merge(group_df[['SKUcode', 'Quantity']], vendor_sheet_df,
                                     how='left', left_on='SKUcode', right_on='skuProductCode')

                merged_df['quantity'] = merged_df['Quantity']

                required_columns = [
                    'id', 'priceContract', 'minimumOrderQty', 'skuProductCode', 'category',
                    'subCategory', 'productTitle', 'recommendedQty', 'lastAuditedStock',
                    'currentStock', 'quantity', 'baseUnit', 'price', 'conversion', 'quantity2',
                    'secondaryUnit', 'secondaryUnitPrice', 'discount', 'tax'
                ]

                missing_columns = [col for col in required_columns if col not in merged_df.columns]
                if missing_columns:
                    print(f"Skipping {filename}: Missing columns in {vendor}'s sheet: {missing_columns}")
                    continue

                merged_df = merged_df[required_columns]
                merged_df.to_csv(file_path, index=False)
                print(f"Saved: {file_path}")

                csv_file_map.append({
                    'Vendor': vendor,
                    'Location': location,
                    'Date': date,
                    'Slot': slot,
                    'Filename': filename,
                    'Filepath': file_path
                })

            except Exception as e:
                print(f"Error while processing {filename}: {e}")
                continue

        csv_file_map_df = pd.DataFrame(csv_file_map)
        return csv_file_map_df

    except Exception as e:
        print("Failed to prepare CSVs:")
        traceback.print_exc()
        return pd.DataFrame()

def upload_bulk_orders_from_df(driver, wait, csv_file_map_df):
    successful_groups = []
    failed_groups = []

    for _, row in csv_file_map_df.iterrows():
        try:
            vendor = row['Vendor']
            pod = row['Location']
            slot = row['Slot']
            date = row['Date']
            file_path = row['Filepath']

            print(f"Processing: {vendor} | {pod} | {slot} | {date}")

            driver.get("https://www.supplynote.in/orders/create")
            wait.until(EC.presence_of_element_located((By.TAG_NAME, 'body')))

            vendor_input = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, 'input[placeholder="e.g Local Vendor"]')))
            select_suggestion(wait, vendor_input, vendor)
            time.sleep(0.5)

            pod_input = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, 'input[placeholder="e.g Bagmane"]')))
            select_suggestion(wait, pod_input, pod)
            time.sleep(0.5)

            try:
                billing_input = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, 'input[placeholder="e.g Bagmane"]')))
                billing_input.clear()
                billing_input.send_keys(pod)

                suggestions = wait.until(
                    EC.presence_of_all_elements_located((By.CSS_SELECTOR, "ul.md-autocomplete-suggestions li"))
                )
                for suggestion in suggestions:
                    if pod in suggestion.text:
                        suggestion.click()
                        break
            except NoSuchElementException:
                print("Billing address not found. Skipping billing input...")

            date_inputs = wait.until(EC.presence_of_all_elements_located((By.CSS_SELECTOR, '.md-datepicker-input')))
            if len(date_inputs) > 1:
                formatted_date = datetime.strptime(date, '%d/%m/%Y').strftime('%m/%d/%Y')
                date_inputs[1].send_keys(formatted_date)
            time.sleep(0.5)

            bulk_add_button = wait.until(
                EC.element_to_be_clickable((By.XPATH, "//button[.//span[text()='Bulk Add']]"))
            )
            bulk_add_button.click()
            time.sleep(0.5)

            file_input = wait.until(EC.presence_of_element_located((By.ID, "fileInput")))
            driver.execute_script("arguments[0].classList.remove('ng-hide')", file_input)
            file_input.send_keys(file_path)
            time.sleep(1)
            upload_button = wait.until(
                EC.element_to_be_clickable((By.XPATH, "//button[.//span[text()='Upload']]"))
            )
            upload_button.click()
            time.sleep(2.5)
            print(f"Uploaded CSV for {vendor} at {pod} on {date} - {slot}")
            
            if submit(driver):
                successful_groups.append((vendor, pod, slot, date))
            else:
                failed_groups.append((vendor, pod, slot, date))

        except Exception as e:
            print(f"Failed to upload for {vendor} | {pod} | {slot} | {date}: {e}")
            failed_groups.append((vendor, pod, slot, date))
            continue       

    return successful_groups, failed_groups

def main():
    scope = ["https://spreadsheets.google.com/feeds", "https://www.googleapis.com/auth/drive"]
    credentials = ServiceAccountCredentials.from_json_keyfile_name(r"C:\Users\benak\OneDrive\Desktop\VS Code files - Pawan\service-key.json", scope)
    client = gspread.authorize(credentials)

    driver = setup_driver()
    wait = WebDriverWait(driver, 20)

    try:
        driver.get("https://www.supplynote.in/signin")
        login(driver, wait, 'Snaccbyswiggy', 'Newage@2025')

        sheet_name = "BLR-Forecasting-Sheet-POs-Pawan-3-New-Template"
        transformed_sheet_name = "PO_Status"
        output_directory = r"C:\Users\benak\OneDrive\Desktop\VS Code files - Pawan\POs"

        csv_file_map_df = prepare_csv_files_from_sheets(client, sheet_name, transformed_sheet_name, output_directory)
        csv_file_map_df['Filepath'] = csv_file_map_df['Filepath'].str.replace('\\', '\\\\', regex=False)

        successful_groups, failed_groups = upload_bulk_orders_from_df(driver, wait, csv_file_map_df)

        print("\nSummary:")
        print(f"Successful uploads: {len(successful_groups)}")
        print(f"Failed uploads: {len(failed_groups)}")
        failed_groups

        while len(failed_groups) != 0:
            df_failed = pd.DataFrame(failed_groups, columns=['Vendor', 'Location', 'Slot', 'Date'])
            new_df_csv_file_map_df = pd.merge(csv_file_map_df, df_failed, how='right', on=['Vendor', 'Location', 'Date', 'Slot'])
            successful_groups, failed_groups = upload_bulk_orders_from_df(driver, wait, new_df_csv_file_map_df)

        if len(failed_groups) == 0:
            print("All Purchase Orders raised successfully")
            driver.quit()

    finally:
        driver.quit()

if __name__ == "__main__":
    main()
